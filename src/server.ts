import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { handleApiRoute } from "./api";
import { readConfig, initConfig, validateConfig } from "./config";
import { buildProxyHandler } from "./proxy";

export function startServer(): void {
  // Initialize config from example if missing
  if (initConfig()) {
    console.log("📝 已从模板创建默认配置 — 请编辑配置文件中填入你的 API Key。");
  }

  // Load and validate config at startup
  const config = readConfig();
  validateConfig(config);

  const proxyHandler = buildProxyHandler();
  // dist-web/ at package root (works for both dev and npm-installed)
  const WEB_DIST = join(dirname(import.meta.dir), "dist-web");

  Bun.serve({
    port: config.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // REST API for config management
      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(req);
      }

      // Proxy forwarding for API calls
      if (url.pathname.startsWith("/v1/")) {
        return proxyHandler(req);
      }

      // Static files from dist-web (production mode)
      if (existsSync(WEB_DIST)) {
        const requestedPath = url.pathname === "/" ? "index.html" : url.pathname;
        const filePath = join(WEB_DIST, requestedPath);
        // Prevent path traversal: ensure resolved path is within WEB_DIST
        if (!filePath.startsWith(WEB_DIST + "/")) {
          return new Response("禁止访问", { status: 403 });
        }
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
        // SPA fallback: serve index.html for any unmatched route
        const indexFile = Bun.file(join(WEB_DIST, "index.html"));
        if (await indexFile.exists()) {
          return new Response(indexFile);
        }
      }

      // Development: redirect to Vite dev server
      return Response.redirect(`http://localhost:5173${url.pathname}`, 302);
    },
  });

  console.log(`🚀 3router listening on http://localhost:${config.port}`);
  console.log(`   ${config.upstreams.length} 个上游服务，${config.rules.length} 条规则`);
}
