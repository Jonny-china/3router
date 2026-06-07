import * as config from "./config";
import { hashImageBlock, storeImageSummary } from "./image-cache";
import { logRequest } from "./logger";
import { matchRule } from "./router";
import { transformMessagesForTextModel } from "./transform";
import type { Message, Upstream } from "./types";

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
  const hashes: string[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") {
          hashes.push(await hashImageBlock(block));
        }
      }
    }
  }
  return hashes;
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
  if (isStreaming) {
    let accumulated = "";
    stream
      .pipeThrough(new TextDecoderStream())
      .pipeTo(
        new WritableStream<string>({
          write(chunk) {
            accumulated += chunk;
          },
          close() {
            const extracted = extractTextFromSSE(accumulated);
            if (extracted && imageHashes.length > 0) {
              storeImageSummary(imageHashes, extracted);
            }
          },
        }),
      )
      .catch(() => {});
  } else {
    let accumulated = "";
    stream
      .pipeThrough(new TextDecoderStream())
      .pipeTo(
        new WritableStream<string>({
          write(chunk) {
            accumulated += chunk;
          },
          close() {
            try {
              const json = JSON.parse(accumulated);
              const extracted = extractTextFromJsonResponse(json);
              if (extracted && imageHashes.length > 0) {
                storeImageSummary(imageHashes, extracted);
              }
            } catch {
              // Not valid JSON, skip caching
            }
          },
        }),
      )
      .catch(() => {});
  }
}

/**
 * Parse SSE-formatted text and extract concatenated text_delta content.
 */
function extractTextFromSSE(sseText: string): string {
  const lines = sseText.split("\n");
  let text = "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text;
      }
    } catch {
      // Skip malformed JSON lines
    }
  }
  return text;
}

/**
 * Extract text from a non-streaming API response body.
 */
function extractTextFromJsonResponse(json: Record<string, unknown>): string {
  if (!Array.isArray(json.content)) return "";
  return json.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}

/**
 * Creates the proxy handler function.
 * Each call to the handler re-reads config so changes take effect immediately.
 */
export function buildProxyHandler(): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const startTime = Date.now();
    let body: Record<string, unknown> | null = null;

    try {
      const cfg = config.readConfig();
      const url = new URL(req.url);
      const BODY_METHODS = ["POST", "PUT", "PATCH"];
      const hasBody = BODY_METHODS.includes(req.method);
      let messages: Message[] = [];

      if (hasBody) {
        body = (await req.json()) as Record<string, unknown>;
        messages = (body.messages as Message[]) || [];
      }

      const match = matchRule(messages, cfg.rules, cfg.upstreams);

      if (!match) {
        return Response.json(
          { error: { message: "没有匹配的路由规则" } },
          { status: 502 },
        );
      }

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

      const upstreamRes = await fetch(upstreamReq);
      const duration = Date.now() - startTime;

      logRequest({
        method: req.method,
        path: url.pathname,
        status: upstreamRes.status,
        durationMs: duration,
        rule: match.ruleName,
        upstream: match.upstream.name,
        model: match.model,
        requestHeaders: req.headers,
        requestBody: body,
        responseHeaders: upstreamRes.headers,
      });

      // Full transparency: pass through status, headers, and streaming body
      // Bun's fetch transparently decompresses gzip, so remove encoding/length
      // headers to avoid clients trying to decompress already-decoded bodies.
      const responseHeaders = new Headers(upstreamRes.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");

      // Capture response text for caching when the model supports images
      if (hasBody && match.supportsImages && upstreamRes.body) {
        const imageHashes = await extractImageHashes(messages);
        if (imageHashes.length > 0) {
          const [clientStream, cacheStream] = upstreamRes.body.tee();
          const isStreaming =
            responseHeaders.get("content-type")?.includes("text/event-stream") ?? false;
          captureStreamForCache(cacheStream, imageHashes, isStreaming);
          return new Response(clientStream, {
            status: upstreamRes.status,
            headers: responseHeaders,
          });
        }
      }

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知代理错误";
      const duration = Date.now() - startTime;

      logRequest({
        method: req.method,
        path: new URL(req.url).pathname,
        status: 502,
        durationMs: duration,
        error: message,
        requestHeaders: req.headers,
        requestBody: body,
      });

      return Response.json({ error: { message: `代理错误：${message}` } }, { status: 502 });
    }
  };
}
