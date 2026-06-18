import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { handleApiRoute } from "./api";
import { readConfig, initConfig, validateConfig } from "./config";
import { buildProxyHandler } from "./proxy";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function getWebDist(): string {
  return join(packageRoot(), "dist-web");
}

function incomingToRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? `localhost:${req.socket.localPort ?? 9191}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return Promise.resolve(new Request(url, { method, headers }));
  }
  const body = Readable.toWeb(req) as unknown as NodeReadableStream<Uint8Array>;
  return Promise.resolve(
    new Request(url, {
      method,
      headers,
      body,
      duplex: "half",
    }),
  );
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = response.body as unknown as NodeReadableStream<Uint8Array>;
    const stream = Readable.fromWeb(body);
    let settled = false;
    const cleanup = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    stream.on("error", (err) =>
      cleanup(() => {
        stream.destroy();
        if (!res.writableEnded) res.destroy();
        reject(err);
      }),
    );
    res.on("error", (err) =>
      cleanup(() => {
        stream.destroy();
        reject(err);
      }),
    );
    res.on("close", () =>
      cleanup(() => {
        stream.destroy();
        resolve();
      }),
    );
    res.on("finish", () => cleanup(() => resolve()));
    stream.pipe(res);
  });
}

export async function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const request = await incomingToRequest(req);
    const url = new URL(request.url);
    let response: Response;

    if (url.pathname.startsWith("/api/")) {
      response = await handleApiRoute(request);
    } else if (url.pathname.startsWith("/v1/")) {
      response = await buildProxyHandler()(request);
    } else {
      response = await serveStatic(url.pathname);
    }

    await sendResponse(res, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[请求错误] ${message}`);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: message }));
    }
  }
}

export async function serveStatic(
  pathname: string,
  webDist: string = getWebDist(),
): Promise<Response> {
  if (!existsSync(webDist)) {
    return Response.redirect(`http://localhost:5173${pathname}`, 302);
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(webDist, requested);

  if (!filePath.startsWith(webDist + "/")) {
    return new Response("禁止访问", { status: 403 });
  }

  try {
    const buffer = await readFile(filePath);
    return new Response(buffer, {
      headers: { "content-type": mimeFor(filePath) },
    });
  } catch {
    // SPA fallback
    try {
      const indexBuffer = await readFile(join(webDist, "index.html"));
      return new Response(indexBuffer, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}

export function startServer(): void {
  if (initConfig()) {
    console.log("📝 已从模板创建默认配置 — 请编辑配置文件中填入你的 API Key。");
  }
  const config = readConfig();
  validateConfig(config);

  const server = createServer((req, res) => {
    void handleWebRequest(req, res);
  });

  server.listen(config.port, () => {
    console.log(`🚀 3router listening on http://localhost:${config.port}`);
    console.log(`   ${config.upstreams.length} 个上游服务，${config.rules.length} 条规则`);
  });
}
