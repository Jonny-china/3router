import * as config from "./config";
import { matchRule } from "./router";
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
    if (lower !== "authorization" && lower !== "x-api-key") {
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
 * Creates the proxy handler function.
 * Each call to the handler re-reads config so changes take effect immediately.
 */
export function buildProxyHandler(): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    try {
      const cfg = config.readConfig();
      const url = new URL(req.url);
      const BODY_METHODS = ["POST", "PUT", "PATCH"];
      const hasBody = BODY_METHODS.includes(req.method);
      let body: Record<string, unknown> | null = null;
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

      console.log(
        `[${new Date().toISOString()}] [${match.model}] [${match.upstream.name}] [${upstreamRes.status}] ${duration}ms`,
      );

      // Full transparency: pass through status, headers, and streaming body
      // Bun's fetch transparently decompresses gzip, so remove encoding/length
      // headers to avoid clients trying to decompress already-decoded bodies.
      const responseHeaders = new Headers(upstreamRes.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知代理错误";
      console.error(`[代理错误] ${message}`);
      return Response.json({ error: { message: `代理错误：${message}` } }, { status: 502 });
    }
  };
}
