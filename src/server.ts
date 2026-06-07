import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { handleApiRoute } from "./api";
import { readConfig, initConfig, validateConfig } from "./config";
import { buildProxyHandler } from "./proxy";

// Initialize config from example if missing
if (initConfig()) {
  console.log("📝 Created config.json from config.example.json — edit it with your API keys.");
}

// Load and validate config at startup
const config = readConfig();
validateConfig(config);

const proxyHandler = buildProxyHandler();
const WEB_DIST = join(import.meta.dir, "..", "web", "dist");

const server = Bun.serve({
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

    // Static files from web/dist (production mode)
    if (existsSync(WEB_DIST)) {
      const requestedPath = url.pathname === "/" ? "index.html" : url.pathname;
      const filePath = resolve(WEB_DIST, requestedPath);
      // Prevent path traversal: ensure resolved path is within WEB_DIST
      if (!filePath.startsWith(WEB_DIST + "/")) {
        return new Response("Forbidden", { status: 403 });
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
    return Response.redirect("http://localhost:5173" + url.pathname, 302);
  },
});

console.log(`🚀 3router listening on http://localhost:${server.port}`);
console.log(`   ${config.upstreams.length} upstream(s), ${config.rules.length} rule(s)`);
