import * as config from "./config";
import { hashImageBlock, storeImageSummary } from "./image-cache";
import { matchRule } from "./router";
import { extractTextFromSSE, extractTextFromJsonResponse } from "./stream-parser";
import { transformMessagesForTextModel } from "./transform";
import { logger, newRequestId } from "./logger";
import type { ContentBlock, Message, Upstream } from "./types";

/**
 * Builds the request to send to the upstream API.
 * Forwards the original HTTP method. Replaces the model in the body (when present)
 * and sets the correct auth header based on the upstream's auth scheme.
 * All other headers and body fields pass through unchanged.
 */
export function buildUpstreamRequest(
  method: string,
  urlPath: string,
  originalHeaders: Headers,
  body: Record<string, unknown> | null,
  upstream: Upstream,
  model: string | null,
): Request {
  const baseUrl = upstream.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}${urlPath}`;

  const headers = new Headers();
  originalHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== "authorization" && lower !== "x-api-key" && lower !== "host") {
      headers.set(key, value);
    }
  });

  const scheme = upstream.authScheme || "bearer";
  if (scheme === "x-api-key") {
    headers.set("x-api-key", upstream.apiKey);
  } else {
    headers.set("Authorization", `Bearer ${upstream.apiKey}`);
  }

  const init: RequestInit = { method, headers };
  if (body) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const modifiedBody = model ? { ...body, model } : body;
    init.body = JSON.stringify(modifiedBody);
  }

  return new Request(url, init);
}

/**
 * Hash all image blocks found across all messages.
 * Returns an array of hex-encoded SHA-256 hashes.
 */
async function extractImageHashes(messages: Message[]): Promise<string[]> {
  const blocks: ContentBlock[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") blocks.push(block);
      }
    }
  }
  return Promise.all(blocks.map(hashImageBlock));
}

/**
 * Read a tee'd response stream branch in the background to accumulate
 * text content, then cache it under the given image hashes.
 * Handles both SSE streaming and JSON non-streaming responses.
 * Errors are silently swallowed — caching failure only means a cache miss later.
 */
function captureStreamForCache(
  stream: ReadableStream<Uint8Array>,
  imageHashes: string[],
  isStreaming: boolean,
): void {
  const MAX_CACHE_CHARS = 512 * 1024;

  const processText = isStreaming
    ? extractTextFromSSE
    : (text: string) => {
        try {
          return extractTextFromJsonResponse(JSON.parse(text));
        } catch {
          return "";
        }
      };

  // Fire-and-forget: read the tee'd stream branch, accumulate decoded text,
  // and cache it under the image hashes when the stream closes.
  void (async () => {
    let accumulated = "";
    let charsReceived = 0;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        charsReceived += chunk.length;
        if (charsReceived > MAX_CACHE_CHARS) {
          await reader.cancel().catch(() => {});
          return;
        }
        accumulated += chunk;
      }
      // Flush any trailing bytes held in the decoder.
      const tail = decoder.decode();
      if (tail) accumulated += tail;
      const extracted = processText(accumulated);
      if (extracted && imageHashes.length > 0) {
        storeImageSummary(imageHashes, extracted);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      logger.error("缓存捕获失败", { error: err instanceof Error ? err.message : String(err) });
    }
  })();
}

/**
 * 包装响应 body 流，记录传输字节数与结束原因（done | error | abort）。
 * 这是断连诊断的核心埋点：每次请求的 stream.end 会精确显示流是怎么结束的。
 */
function wrapStream(
  body: ReadableStream<Uint8Array> | null,
  requestId: string,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    logger.info("stream.end", { requestId, bytes: 0, reason: "done", durationMs: 0 });
    return body;
  }
  const reader = body.getReader();
  let bytes = 0;
  const tStart = performance.now();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          logger.info("stream.end", {
            requestId,
            bytes,
            reason: "done",
            durationMs: Math.round(performance.now() - tStart),
          });
          controller.close();
          return;
        }
        if (value) bytes += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        logger.error("stream.end", {
          requestId,
          bytes,
          reason: err instanceof Error && err.name === "AbortError" ? "abort" : "error",
          error: err instanceof Error ? err.message : String(err),
        });
        controller.error(err);
      }
    },
    cancel() {
      logger.info("stream.end", { requestId, bytes, reason: "abort" });
    },
  });
}

/**
 * Creates the proxy handler function.
 * Each call to the handler re-reads config so changes take effect immediately.
 */
export function buildProxyHandler(): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const requestId = newRequestId();
    const t0 = performance.now();
    const url = new URL(req.url);
    logger.info("request.start", { requestId, method: req.method, path: url.pathname });

    let body: Record<string, unknown> | null = null;

    try {
      const cfg = config.readConfig();
      const BODY_METHODS = ["POST", "PUT", "PATCH"];
      const hasBody = BODY_METHODS.includes(req.method);
      let messages: Message[] = [];

      if (hasBody) {
        body = (await req.json()) as Record<string, unknown>;
        messages = (body.messages as Message[]) || [];
      }

      const match = matchRule(messages, cfg.rules, cfg.upstreams);

      if (!match) {
        logger.warn("request.start", { requestId, result: "no_match" });
        return Response.json(
          { error: { message: "没有匹配的路由规则" } },
          { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      logger.info("request.start", {
        requestId,
        upstream: match.upstream.name,
        model: match.model,
        supportsImages: match.supportsImages,
      });

      // Transform messages for models that don't support images
      if (hasBody && !match.supportsImages) {
        const transformedMessages = await transformMessagesForTextModel(messages);
        body = { ...body, messages: transformedMessages };
      }

      const upstreamReq = buildUpstreamRequest(
        req.method,
        url.pathname + url.search,
        req.headers,
        body,
        match.upstream,
        hasBody ? match.model : null,
      );

      // Pre-compute image hashes for caching (before fetch to avoid delaying response)
      const imageHashes = hasBody && match.supportsImages ? await extractImageHashes(messages) : [];

      const upstreamRes = await fetch(upstreamReq);
      logger.info("upstream.fetch", {
        requestId,
        status: upstreamRes.status,
        durationMs: Math.round(performance.now() - t0),
        stream: upstreamRes.headers.get("content-type")?.includes("event-stream") ?? false,
      });

      // Full transparency: pass through status, headers, and streaming body.
      // Bun's fetch transparently decompresses gzip, so remove encoding/length
      // headers to avoid clients trying to decompress already-decoded bodies.
      const responseHeaders = new Headers(upstreamRes.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");

      // Capture response text for caching when the model supports images.
      // clientStream 包装埋点（stream.end），cacheStream 不变（给后台缓存捕获）。
      if (imageHashes.length > 0 && upstreamRes.body) {
        const [clientStream, cacheStream] = upstreamRes.body.tee();
        const isStreaming =
          responseHeaders.get("content-type")?.includes("text/event-stream") ?? false;
        captureStreamForCache(cacheStream, imageHashes, isStreaming);
        return new Response(wrapStream(clientStream, requestId), {
          status: upstreamRes.status,
          headers: responseHeaders,
        });
      }

      return new Response(wrapStream(upstreamRes.body, requestId), {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知代理错误";
      logger.error("proxy.error", {
        requestId,
        method: req.method,
        path: url.pathname,
        error: message,
      });
      return Response.json(
        { error: { message: `代理错误：${message}` } },
        { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
  };
}
