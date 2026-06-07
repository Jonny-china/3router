import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashImageBlock, storeImageSummary, clearCache } from "./image-cache";
import { buildUpstreamRequest } from "./proxy";
import { transformMessagesForTextModel } from "./transform";
import type { Message, ContentBlock, Upstream } from "./types";

const upstream: Upstream = {
  id: "up-1",
  name: "Test",
  baseUrl: "https://api.test.com",
  apiKey: "sk-test-123",
};

describe("buildUpstreamRequest", () => {
  it("replaces model in body and sets Authorization header", async () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": "original-key",
    });
    const body = {
      model: "original-model",
      messages: [{ role: "user" as const, content: "hi" }],
    };

    const result = buildUpstreamRequest(
      "POST",
      "/v1/messages",
      headers,
      body,
      upstream,
      "claude-opus-4-6",
    );

    expect(result.method).toBe("POST");
    expect(result.url).toBe("https://api.test.com/v1/messages");
    expect(result.headers.get("Authorization")).toBe("Bearer sk-test-123");
    expect(result.headers.get("x-api-key")).toBeNull();
    expect(result.headers.get("content-type")).toBe("application/json");
    const resultBody = await result.json();
    expect(resultBody.model).toBe("claude-opus-4-6");
    expect(resultBody.messages[0].content).toBe("hi");
  });

  it("handles baseUrl with trailing slash", () => {
    const upstreamWithSlash: Upstream = {
      ...upstream,
      baseUrl: "https://api.test.com/",
    };

    const result = buildUpstreamRequest(
      "POST",
      "/v1/messages",
      new Headers(),
      { model: "x" },
      upstreamWithSlash,
      "model-1",
    );

    expect(result.url).toBe("https://api.test.com/v1/messages");
  });

  it("preserves original headers except authorization and x-api-key", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-custom-header": "custom-value",
      authorization: "Bearer original",
      "x-api-key": "original-key",
    });

    const result = buildUpstreamRequest(
      "POST",
      "/v1/messages",
      headers,
      { model: "x" },
      upstream,
      "model-1",
    );

    expect(result.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(result.headers.get("x-custom-header")).toBe("custom-value");
    expect(result.headers.get("Authorization")).toBe("Bearer sk-test-123");
    expect(result.headers.get("x-api-key")).toBeNull();
  });

  it("preserves all body fields besides model", async () => {
    const body = {
      model: "old-model",
      max_tokens: 4096,
      stream: true,
      messages: [{ role: "user" as const, content: "test" }],
      system: "You are helpful.",
    };

    const result = buildUpstreamRequest(
      "POST",
      "/v1/messages",
      new Headers(),
      body,
      upstream,
      "new-model",
    );

    const resultBody = await result.json();
    expect(resultBody.model).toBe("new-model");
    expect(resultBody.max_tokens).toBe(4096);
    expect(resultBody.stream).toBe(true);
    expect(resultBody.system).toBe("You are helpful.");
  });

  it("forwards GET requests without a body", () => {
    const result = buildUpstreamRequest("GET", "/v1/models", new Headers(), null, upstream, null);

    expect(result.method).toBe("GET");
    expect(result.url).toBe("https://api.test.com/v1/models");
    expect(result.headers.get("Authorization")).toBe("Bearer sk-test-123");
  });

  it("uses x-api-key auth scheme when configured", () => {
    const anthropicUpstream: Upstream = {
      ...upstream,
      authScheme: "x-api-key",
    };

    const result = buildUpstreamRequest(
      "POST",
      "/v1/messages",
      new Headers(),
      { model: "x" },
      anthropicUpstream,
      "claude-opus-4-6",
    );

    expect(result.headers.get("x-api-key")).toBe("sk-test-123");
    expect(result.headers.get("Authorization")).toBeNull();
  });

  it("does not replace model when model is null", async () => {
    const body = { model: "original-model", messages: [] };

    const result = buildUpstreamRequest(
      "POST",
      "/v1/messages",
      new Headers(),
      body,
      upstream,
      null,
    );

    const resultBody = await result.json();
    expect(resultBody.model).toBe("original-model");
  });
});

describe("buildProxyHandler", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "3router-proxy-"));
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns 502 when config read fails", async () => {
    // Write an invalid config
    writeFileSync(join(testDir, "config.json"), "not json");

    const { buildProxyHandler } = await import("./proxy");
    const handler = buildProxyHandler();

    const req = new Request("http://localhost:9191/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    const res = await handler(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message.toLowerCase()).toContain("parse error");
  });

  it("returns 502 when no rule matches", async () => {
    const config = {
      port: 9191,
      upstreams: [{ id: "up-1", name: "T", baseUrl: "https://api.test.com", apiKey: "k" }],
      rules: [
        {
          id: "r-1",
          name: "Image",
          condition: "has_image",
          upstreamId: "up-1",
          model: "claude-opus-4-6",
          priority: 1,
        },
      ],
    };
    writeFileSync(join(testDir, "config.json"), JSON.stringify(config));

    const { buildProxyHandler } = await import("./proxy");
    const handler = buildProxyHandler();

    // Text message won't match has_image rule, and no default rule exists
    const req = new Request("http://localhost:9191/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await handler(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("没有匹配的路由规则");
  });
});

describe("proxy integration: message transform for text-only models", () => {
  beforeEach(() => {
    clearCache();
  });

  it("strips image blocks from history when routing to text-only model", async () => {
    const imageBlock: ContentBlock = {
      type: "image",
      source: { type: "base64", data: "integration-test-data" },
    };
    const hash = await hashImageBlock(imageBlock);
    storeImageSummary([hash], "图中显示了一个登录表单");

    const messages: Message[] = [
      {
        role: "user",
        content: [imageBlock, { type: "text", text: "看看这个截图" }],
      },
      { role: "assistant", content: "我看到了一个登录表单" },
      { role: "user", content: "帮我写一个登录组件" },
    ];

    const transformed = await transformMessagesForTextModel(messages);

    expect(transformed[0].content).toEqual([
      { type: "text", text: "[图片描述: 图中显示了一个登录表单]" },
      { type: "text", text: "看看这个截图" },
    ]);
    expect(transformed[1].content).toBe("我看到了一个登录表单");
    expect(transformed[2].content).toBe("帮我写一个登录组件");
  });

  it("uses [image] placeholder when cache is empty", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "no-cache" } }],
      },
      { role: "user", content: "继续" },
    ];

    const transformed = await transformMessagesForTextModel(messages);
    expect(transformed[0].content).toEqual([{ type: "text", text: "[image]" }]);
  });
});
