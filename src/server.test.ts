import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFetch, serveStatic, getWebDist } from "./server";

let testHome: string;
let fakeWebDist: string;
let server: { stop: () => void; port: number };

beforeAll(() => {
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

  fakeWebDist = mkdtempSync(join(tmpdir(), "3router-web-"));
  writeFileSync(join(fakeWebDist, "index.html"), "<!doctype html><title>3router</title>");
  writeFileSync(join(fakeWebDist, "app.js"), "console.log('hi');");
  mkdirSync(join(fakeWebDist, "assets"), { recursive: true });
  writeFileSync(join(fakeWebDist, "assets", "style.css"), "body{color:red}");

  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handleFetch });
});

afterAll(() => {
  delete process.env.THREEROUTER_HOME;
  server.stop();
  rmSync(testHome, { recursive: true, force: true });
  rmSync(fakeWebDist, { recursive: true, force: true });
});

const baseUrl = () => `http://127.0.0.1:${server.port}`;

describe("handleFetch: /api/config", () => {
  it("returns config as JSON with 200", async () => {
    const res = await fetch(`${baseUrl()}/api/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upstreams[0].id).toBe("up-1");
  });
});

describe("handleFetch: unknown api route", () => {
  it("returns 404 for non-existent /api path", async () => {
    const res = await fetch(`${baseUrl()}/api/no-such-route`);
    expect(res.status).toBe(404);
  });
});

describe("handleFetch: /v1 proxy", () => {
  it("returns 502 when body parse fails", async () => {
    const res = await fetch(`${baseUrl()}/v1/messages`, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error.message).toBeTruthy();
  });
});

describe("serveStatic against temp dist-web", () => {
  it("serves index.html for /", async () => {
    const res = await serveStatic("/", fakeWebDist);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>3router</title>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves .js with correct mime", async () => {
    const res = await serveStatic("/app.js", fakeWebDist);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  });

  it("serves .css with correct mime", async () => {
    const res = await serveStatic("/assets/style.css", fakeWebDist);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("SPA fallback for unknown route when index.html exists", async () => {
    const res = await serveStatic("/no/such/route", fakeWebDist);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>3router</title>");
  });

  it("blocks path traversal via ..", async () => {
    const res = await serveStatic("/../../etc/passwd", fakeWebDist);
    expect(res.status).toBe(403);
  });

  it("blocks multi-dot traversal", async () => {
    const res = await serveStatic("/foo/../../../etc/shadow", fakeWebDist);
    expect(res.status).toBe(403);
  });

  it("does not break out via URL-encoded traversal (encoded 当字面段 → SPA fallback)", async () => {
    // 直接调 serveStatic，绕开 fetch 客户端对 %2e%2e 的 resolve
    const res = await serveStatic("/%2e%2e/%2e%2e/etc/passwd", fakeWebDist);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>3router</title>");
  });

  it("returns 404 when neither file nor index.html exists", async () => {
    const empty = mkdtempSync(join(tmpdir(), "3router-empty-"));
    try {
      const res = await serveStatic("/some/missing/path", empty);
      expect(res.status).toBe(404);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("redirects to vite dev server when webDist does not exist", async () => {
    const res = await serveStatic("/", "/tmp/3router-nonexistent-xxxxx");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5173/");
  });

  it("getWebDist points to dist-web under package root", () => {
    expect(getWebDist().endsWith("dist-web")).toBe(true);
  });
});
