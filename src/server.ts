import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

import { handleApiRoute } from "./api";
import { readConfig, initConfig, validateConfig } from "./config";
import { buildProxyHandler } from "./proxy";

// Initialize config from example if missing
if (initConfig()) {
  console.log("📝 已从 config.example.json 创建 config.json — 请填入你的 API Key。");
}

// Load and validate config at startup
const config = readConfig();
validateConfig(config);

// --- TLS certificate setup ---
const CERTS_DIR = join(import.meta.dir, "..", "certs");
const CERT_PATH = join(CERTS_DIR, "cert.pem");
const KEY_PATH = join(CERTS_DIR, "key.pem");

function ensureCerts() {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) return;

  if (!existsSync(CERTS_DIR)) mkdirSync(CERTS_DIR, { recursive: true });

  // Prefer mkcert: generates certs trusted by the system CA store
  const mkcert = Bun.spawnSync(["mkcert", "localhost", "127.0.0.1"], {
    cwd: CERTS_DIR,
  });
  if (mkcert.exitCode === 0) {
    // mkcert outputs to <first-name>+<n>.pem / <first-name>+<n>-key.pem
    const mkcertCert = join(CERTS_DIR, "localhost+1.pem");
    const mkcertKey = join(CERTS_DIR, "localhost+1-key.pem");
    renameSync(mkcertCert, CERT_PATH);
    renameSync(mkcertKey, KEY_PATH);
    console.log("🔐 证书已通过 mkcert 生成（系统信任）");
    return;
  }

  // Fallback to openssl (self-signed, browsers will warn)
  console.log("🔐 正在生成自签名 HTTPS 证书（mkcert 不可用，浏览器会提示不安全）...");

  const { exitCode, stderr } = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    KEY_PATH,
    "-out",
    CERT_PATH,
    "-days",
    "365",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  if (exitCode !== 0) {
    console.error(
      `❌ 证书生成失败，请确认已安装 openssl 或 mkcert。\n${stderr?.toString() ?? ""}`,
    );
    process.exit(1);
  }

  console.log("⚠️  自签名证书已生成 — 首次访问请在浏览器中手动信任");
}

ensureCerts();

const proxyHandler = buildProxyHandler();
const WEB_DIST = join(import.meta.dir, "..", "web", "dist");

const server = Bun.serve({
  port: config.port,
  tls: {
    cert: Bun.file(CERT_PATH),
    key: Bun.file(KEY_PATH),
  },

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
    return Response.redirect(`https://localhost:5173${url.pathname}`, 302);
  },
});

console.log(`🚀 3router listening on https://localhost:${server.port}`);
console.log(`   ${config.upstreams.length} 个上游服务，${config.rules.length} 条规则`);
