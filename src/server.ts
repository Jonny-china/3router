import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { embeddedFiles } from "bun";

import { handleApiRoute } from "./api";
import { readConfig, initConfig, validateConfig } from "./config";
import { logger } from "./logger";
import { getBasePath } from "./paths";
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
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * 前端构建产物目录探测（仅开发模式或外部 dist-web 时使用）：
 * 环境变量 > 二进制旁 dist-web > ~/.3router/dist-web > 开发 src 旁 dist-web。
 * 编译后的二进制优先用 embeddedFiles（见 serveStatic），不走此路径。
 */
export function getWebDist(): string {
  if (process.env.THREEROUTER_WEB_DIST) return process.env.THREEROUTER_WEB_DIST;
  const besideBin = join(dirname(process.execPath), "dist-web");
  if (existsSync(besideBin)) return besideBin;
  const homeDist = join(getBasePath(), "dist-web");
  if (existsSync(homeDist)) return homeDist;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
}

/**
 * 静态文件服务（Web 管理面板）。
 * 优先从编译时 embed 的文件（embeddedFiles，单文件化后的 index.html）读取；
 * 未 embed（开发模式）时回退到文件系统 dist-web，再回退到 vite dev server。
 */
export async function serveStatic(
  pathname: string,
  webDist: string = getWebDist(),
): Promise<Response> {
  // 1. 编译时 embed：单文件化后的 index.html（SPA，所有路由都返回它）。
  // bun-types 的 embeddedFiles 元素是 Blob，但运行时带 name（文件名），这里 cast。
  const allEmbedded = embeddedFiles as unknown as Array<Blob & { name: string }>;
  // embed 后 name 带路径前缀（如 "dist-web/index.html"），用 endsWith 匹配
  const embedded = allEmbedded.find((f) => f.name.endsWith("index.html"));
  if (embedded) {
    return new Response(embedded, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // 2. 开发模式：文件系统 dist-web
  if (!existsSync(webDist)) {
    return Response.redirect(`http://localhost:5173${pathname}`, 302);
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(webDist, requested);
  if (!filePath.startsWith(webDist + "/")) return new Response("禁止访问", { status: 403 });

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, { headers: { "content-type": mimeFor(filePath) } });
  }
  // SPA fallback
  const index = Bun.file(join(webDist, "index.html"));
  return (await index.exists())
    ? new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } })
    : new Response("Not Found", { status: 404 });
}

/** 路由分发：/v1/ → 代理上游，/api/ → 管理 API，其余 → 静态资源 */
export async function handleFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname.startsWith("/v1/")) return await buildProxyHandler()(req);
    if (url.pathname.startsWith("/api/")) return await handleApiRoute(req);
    return await serveStatic(url.pathname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("请求错误", { path: url.pathname, error: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

export function startServer(): void {
  if (initConfig()) logger.info("已从模板创建默认配置");
  const config = readConfig();
  validateConfig(config);

  Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    fetch: handleFetch,
  });

  logger.info("3router 启动", {
    port: config.port,
    upstreams: config.upstreams.length,
    rules: config.rules.length,
  });
}
