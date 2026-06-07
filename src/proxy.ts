import * as config from "./config";
import { matchRule } from "./router";
import type { Message, Upstream } from "./types";

/**
 * Builds the request to send to the upstream API.
 * Replaces the model in the body and the Authorization header.
 * All other headers and body fields pass through unchanged.
 */
export function buildUpstreamRequest(
  urlPath: string,
  originalHeaders: Headers,
  body: Record<string, unknown>,
  upstream: Upstream,
  model: string,
): Request {
  const baseUrl = upstream.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}${urlPath}`;

  const headers = new Headers();
  originalHeaders.forEach((value, key) => {
    if (key.toLowerCase() !== "authorization") {
      headers.set(key, value);
    }
  });
  headers.set("Authorization", `Bearer ${upstream.apiKey}`);

  const modifiedBody = { ...body, model };

  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(modifiedBody),
  });
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
      const body = await req.json();
      const messages: Message[] = body.messages || [];
      const match = matchRule(messages, cfg.rules, cfg.upstreams);

      if (!match) {
        return Response.json(
          { error: { message: "No matching rule found for this request" } },
          { status: 502 },
        );
      }

      const reqUrl = new URL(req.url);
      const upstreamReq = buildUpstreamRequest(
        reqUrl.pathname + reqUrl.search,
        req.headers,
        body,
        match.upstream,
        match.model,
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
      const message = err instanceof Error ? err.message : "Unknown proxy error";
      console.error(`[proxy error] ${message}`);
      return Response.json({ error: { message: `Proxy error: ${message}` } }, { status: 502 });
    }
  };
}
