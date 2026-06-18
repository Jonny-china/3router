import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleWebRequest, serveStatic, getWebDist } from "./server";

let testHome: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "3router-server-"));
  process.env.THREEROUTER_HOME = testHome;

  writeFileSync(
    join(testHome, "config.json"),
    JSON.stringify({
      port: 0,
      upstreams: [
        {
          id: "up-1",
          name: "Anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-test",
          authScheme: "x-api-key",
        },
      ],
      rules: [
        {
          id: "r-1",
          name: "Default",
          condition: "default",
          upstreamId: "up-1",
          model: "claude-sonnet-4-6",
          priority: 999,
          supportsImages: false,
        },
      ],
    }),
  );

  server = createServer((req, res) => {
    void handleWebRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.THREEROUTER_HOME;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(testHome, { recursive: true, force: true });
});

describe("handleWebRequest: /api/config", () => {
  it("returns config as JSON with 200", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upstreams[0].id).toBe("up-1");
  });

  it("returns CORS headers for known origin", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { origin: "http://localhost:9191" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:9191");
  });

  it("handles OPTIONS preflight", async () => {
    const res = await fetch(`${baseUrl}/api/config`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

describe("handleWebRequest: unknown API route", () => {
  it("returns 404 for non-existent /api path", async () => {
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("接口不存在");
  });
});

describe("handleWebRequest: /v1 proxy", () => {
  it("returns 502 when body parse fails", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error.message).toBeTruthy();
  });
});

// Deterministic static-file tests against a temporary fake dist-web.
// These cover path-traversal defense, mime detection, SPA fallback, and
// 404 paths that the previous weak assertions couldn't verify.
describe("serveStatic against temp dist-web", () => {
  let fakeWebDist: string;

  beforeAll(() => {
    fakeWebDist = mkdtempSync(join(tmpdir(), "3router-web-"));
    writeFileSync(join(fakeWebDist, "index.html"), "<!doctype html><title>3router</title>");
    writeFileSync(join(fakeWebDist, "app.js"), "console.log('hi');");
    mkdirSync(join(fakeWebDist, "assets"), { recursive: true });
    writeFileSync(join(fakeWebDist, "assets", "style.css"), "body{color:red}");
  });

  afterAll(() => {
    rmSync(fakeWebDist, { recursive: true, force: true });
  });

  it("serves index.html for /", async () => {
    const res = await serveStatic("/", fakeWebDist);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>3router</title>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves a known file with correct mime (.js)", async () => {
    const res = await serveStatic("/app.js", fakeWebDist);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('hi');");
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  });

  it("serves a known file with correct mime (.css)", async () => {
    const res = await serveStatic("/assets/style.css", fakeWebDist);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("returns SPA fallback for unknown route when index.html exists", async () => {
    const res = await serveStatic("/no/such/route", fakeWebDist);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>3router</title>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("blocks path traversal via .. in pathname", async () => {
    const res = await serveStatic("/../../etc/passwd", fakeWebDist);
    // join resolves to /etc/passwd, which is outside webDist → 403
    expect(res.status).toBe(403);
  });

  it("blocks path traversal via multiple dot-segments reaching outside", async () => {
    const res = await serveStatic("/foo/../../../etc/shadow", fakeWebDist);
    expect(res.status).toBe(403);
  });

  it("does not break out of webDist via URL-encoded traversal", async () => {
    // Serve via the real HTTP handler so URL parsing is exercised end-to-end.
    // %2e%2e%2f stays encoded in pathname, join treats it as a literal segment,
    // and readFile fails → SPA fallback. The defense is that encoded segments
    // never resolve into a real ".." traversal under webDist.
    const res = await fetch(`${baseUrl}/%2e%2e/%2e%2e/etc/passwd`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>3router</title>");
  });

  it("returns 404 when neither file nor index.html exists", async () => {
    const emptyDist = mkdtempSync(join(tmpdir(), "3router-empty-"));
    try {
      const res = await serveStatic("/some/missing/path", emptyDist);
      expect(res.status).toBe(404);
    } finally {
      rmSync(emptyDist, { recursive: true, force: true });
    }
  });

  it("redirects to vite dev server when webDist does not exist", async () => {
    const res = await serveStatic("/", "/tmp/3router-nonexistent-xxxxx");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5173/");
  });

  it("getWebDist points to dist-web under package root", () => {
    const result = getWebDist();
    expect(result.endsWith("dist-web")).toBe(true);
  });
});
