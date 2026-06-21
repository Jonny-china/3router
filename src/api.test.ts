import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleApiRoute } from "./api";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "3router-api-"));
  process.env.THREEROUTER_HOME = testDir;
});

afterEach(() => {
  delete process.env.THREEROUTER_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function baseConfig() {
  return {
    port: 9191,
    upstreams: [
      { id: "up-1", name: "Test", baseUrl: "https://api.test.com", apiKey: "key-1" },
    ],
    rules: [
      {
        id: "rule-1",
        name: "Default",
        condition: "default" as const,
        upstreamId: "up-1",
        model: "claude-sonnet-4-6",
        priority: 999,
      },
    ],
  };
}

function seedConfig(overrides: ReturnType<typeof baseConfig> = baseConfig()) {
  writeFileSync(join(testDir, "config.json"), JSON.stringify(overrides));
}

describe("handleApiRoute: upstreams", () => {
  it("POST creates upstream, returns 201 with the new upstream", async () => {
    seedConfig();
    const res = await handleApiRoute(req("POST", "/api/upstreams", { name: "New", baseUrl: "https://x", apiKey: "k" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("New");
    expect(data.id).toBeTruthy();
  });

  it("POST rejects when missing required fields", async () => {
    seedConfig();
    const res = await handleApiRoute(req("POST", "/api/upstreams", { name: "New" }));
    expect(res.status).toBe(400);
  });

  it("PUT updates an existing upstream by id", async () => {
    seedConfig();
    const res = await handleApiRoute(req("PUT", "/api/upstreams/up-1", { name: "Renamed" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed");
    expect(data.id).toBe("up-1");
  });

  it("PUT returns 404 for unknown upstream id", async () => {
    seedConfig();
    const res = await handleApiRoute(req("PUT", "/api/upstreams/nope", { name: "X" }));
    expect(res.status).toBe(404);
  });

  it("DELETE rejects when rules still reference the upstream", async () => {
    seedConfig();
    const res = await handleApiRoute(req("DELETE", "/api/upstreams/up-1"));
    expect(res.status).toBe(400);
  });

  it("DELETE removes an upstream with no referencing rules", async () => {
    const cfg = baseConfig();
    cfg.upstreams.push({ id: "up-2", name: "Other", baseUrl: "https://y", apiKey: "k2" });
    cfg.rules[0].upstreamId = "up-2"; // rule-1 改引用 up-2，使 up-1 无引用
    seedConfig(cfg);
    const res = await handleApiRoute(req("DELETE", "/api/upstreams/up-1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

describe("handleApiRoute: rules", () => {
  it("POST creates rule, returns 201", async () => {
    seedConfig();
    const res = await handleApiRoute(
      req("POST", "/api/rules", {
        name: "Img",
        condition: "has_image",
        upstreamId: "up-1",
        model: "claude-opus-4-6",
        priority: 1,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("POST rejects when missing required fields", async () => {
    seedConfig();
    const res = await handleApiRoute(req("POST", "/api/rules", { name: "Img" }));
    expect(res.status).toBe(400);
  });

  it("PUT updates a rule by id", async () => {
    seedConfig();
    const res = await handleApiRoute(req("PUT", "/api/rules/rule-1", { name: "Renamed" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Renamed");
    expect(data.id).toBe("rule-1");
  });

  it("PUT returns 404 for unknown rule id", async () => {
    seedConfig();
    const res = await handleApiRoute(req("PUT", "/api/rules/nope", { name: "X" }));
    expect(res.status).toBe(404);
  });

  it("DELETE removes a non-default rule", async () => {
    const cfg = baseConfig();
    cfg.rules.push({
      id: "rule-img",
      name: "Img",
      condition: "has_image" as const,
      upstreamId: "up-1",
      model: "claude-opus-4-6",
      priority: 1,
    });
    seedConfig(cfg);
    const res = await handleApiRoute(req("DELETE", "/api/rules/rule-img"));
    expect(res.status).toBe(200);
  });

  it("DELETE rejects removing the last default rule", async () => {
    seedConfig();
    const res = await handleApiRoute(req("DELETE", "/api/rules/rule-1"));
    expect(res.status).toBe(400);
  });
});

describe("handleApiRoute: misc", () => {
  it("GET /api/config returns the config", async () => {
    seedConfig();
    const res = await handleApiRoute(req("GET", "/api/config"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upstreams[0].id).toBe("up-1");
  });

  it("unknown /api route returns 404", async () => {
    seedConfig();
    const res = await handleApiRoute(req("GET", "/api/no-such-route"));
    expect(res.status).toBe(404);
  });
});
