# Image Context Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When routing to a model that doesn't support images, automatically replace image blocks in conversation history with cached text descriptions from the multimodal model's previous response.

**Architecture:** Two-part system: (1) explicit `supportsImages` flag on Rule configuration for capability declaration, (2) in-memory cache that maps image block hashes to vision model response text, with stream tee + SSE parsing for capture and message transformation for replacement.

**Tech Stack:** Bun, TypeScript, Web Crypto API (SHA-256), ReadableStream.tee(), SSE parsing, React + Ant Design (frontend toggle).

**Spec:** `docs/superpowers/specs/2026-06-07-image-context-preservation.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `supportsImages` to `Rule` (optional) and `RouteMatch` (required) |
| `src/router.ts` | Modify | Return `supportsImages` in match result |
| `src/image-cache.ts` | Create | In-memory cache: hash image blocks → store/retrieve vision model text |
| `src/image-cache.test.ts` | Create | Tests for hashing, cache store/retrieve |
| `src/transform.ts` | Create | Replace image blocks in messages with cached descriptions |
| `src/transform.test.ts` | Create | Tests for message transformation |
| `src/proxy.ts` | Modify | Stream capture for caching; message transform for text-only models |
| `src/router.test.ts` | Modify | Add tests for `supportsImages` in RouteMatch |
| `config.example.json` | Modify | Add `supportsImages` to example rules |
| `web/src/pages/Rules.tsx` | Modify | Add `supportsImages` Switch to rule form + table column |

---

## Task 1: Types & Router

**Files:**
- Modify: `src/types.ts:1-53`
- Modify: `src/router.ts:1-26`
- Modify: `src/router.test.ts:1-150`

### Context

The `Rule` interface needs an optional `supportsImages` boolean so each rule can declare whether its model handles image content. The `RouteMatch` return type needs a required `supportsImages` boolean so `proxy.ts` can decide whether to transform messages.

The router currently returns `{ upstream, model, ruleName }`. It needs to also return `supportsImages` from the matched rule, defaulting to `false` when the field is omitted (backward compatibility with old configs).

- [ ] **Step 1: Write failing tests for `supportsImages` in RouteMatch**

Add three new test cases at the end of the existing `describe("matchRule")` block in `src/router.test.ts`, before the closing `});`:

```typescript
  it("returns supportsImages: true when the matched rule declares it", () => {
    const imgRules: Rule[] = [
      {
        id: "img",
        name: "Image",
        condition: "has_image",
        upstreamId: "up-1",
        model: "vision-model",
        priority: 1,
        supportsImages: true,
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "abc" } }],
      },
    ];
    const result = matchRule(messages, imgRules, upstreams);
    expect(result?.supportsImages).toBe(true);
  });

  it("returns supportsImages: false when the matched rule declares false", () => {
    const textRules: Rule[] = [
      {
        id: "def",
        name: "Default",
        condition: "default",
        upstreamId: "up-2",
        model: "text-model",
        priority: 1,
        supportsImages: false,
      },
    ];
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = matchRule(messages, textRules, upstreams);
    expect(result?.supportsImages).toBe(false);
  });

  it("defaults supportsImages to false when the rule omits the field", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = matchRule(messages, rules, upstreams);
    expect(result?.supportsImages).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/router.test.ts`
Expected: Tests fail — `supportsImages` is not a property on `RouteMatch` yet. The new tests will show `undefined` instead of `true`/`false`.

- [ ] **Step 3: Add `supportsImages` to `Rule` and `RouteMatch` in `types.ts`**

In `src/types.ts`, add `supportsImages?: boolean` to the `Rule` interface:

```typescript
export interface Rule {
  id: string;
  name: string;
  condition: RuleCondition;
  upstreamId: string;
  model: string;
  priority: number; // Lower number = higher priority
  supportsImages?: boolean;
}
```

And add `supportsImages: boolean` (required, not optional) to the `RouteMatch` interface:

```typescript
export interface RouteMatch {
  upstream: Upstream;
  model: string;
  ruleName: string;
  supportsImages: boolean;
}
```

- [ ] **Step 4: Update `router.ts` to return `supportsImages`**

In `src/router.ts`, update the return statement in `matchRule` (currently line 25):

```typescript
  return {
    upstream,
    model: matchedRule.model,
    ruleName: matchedRule.name,
    supportsImages: matchedRule.supportsImages ?? false,
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/router.test.ts`
Expected: All tests pass (both existing and new).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/router.ts src/router.test.ts
git commit -m "feat: add supportsImages to Rule and RouteMatch types"
```

---

## Task 2: Image Cache Module

**Files:**
- Create: `src/image-cache.ts`
- Create: `src/image-cache.test.ts`

### Context

The image cache is an in-memory `Map<string, string>` that maps SHA-256 hashes of image content blocks to the text responses from the multimodal model. Three functions are exported:

- `hashImageBlock(block)` — SHA-256 hash of JSON-serialized content block
- `storeImageSummary(hashes, text)` — store text under multiple hashes
- `getImageSummary(hash)` — retrieve cached text, or `undefined`

The cache is module-scoped (singleton). It lives for the lifetime of the process.

- [ ] **Step 1: Write failing tests in `src/image-cache.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "bun:test";

import { hashImageBlock, storeImageSummary, getImageSummary, clearCache } from "./image-cache";
import type { ContentBlock } from "./types";

describe("hashImageBlock", () => {
  it("produces a consistent hex string for the same block", async () => {
    const block: ContentBlock = { type: "image", source: { type: "base64", data: "abc" } };
    const hash1 = await hashImageBlock(block);
    const hash2 = await hashImageBlock(block);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different blocks", async () => {
    const block1: ContentBlock = { type: "image", source: { type: "base64", data: "abc" } };
    const block2: ContentBlock = { type: "image", source: { type: "base64", data: "xyz" } };
    const hash1 = await hashImageBlock(block1);
    const hash2 = await hashImageBlock(block2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("storeImageSummary / getImageSummary", () => {
  beforeEach(() => {
    clearCache();
  });

  it("stores and retrieves text for a given hash", () => {
    storeImageSummary(["hash-aaa"], "这是一只猫");
    expect(getImageSummary("hash-aaa")).toBe("这是一只猫");
  });

  it("stores under multiple hashes with the same text", () => {
    storeImageSummary(["hash-1", "hash-2"], "两张图的描述");
    expect(getImageSummary("hash-1")).toBe("两张图的描述");
    expect(getImageSummary("hash-2")).toBe("两张图的描述");
  });

  it("returns undefined for unknown hashes", () => {
    expect(getImageSummary("nonexistent")).toBeUndefined();
  });

  it("overwrites existing entries", () => {
    storeImageSummary(["hash-x"], "旧文本");
    storeImageSummary(["hash-x"], "新文本");
    expect(getImageSummary("hash-x")).toBe("新文本");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/image-cache.test.ts`
Expected: Fails — module `./image-cache` does not exist.

- [ ] **Step 3: Implement `src/image-cache.ts`**

```typescript
import type { ContentBlock } from "./types";

const cache = new Map<string, string>();

/**
 * Compute SHA-256 hash of a content block for use as cache key.
 * Returns a lowercase hex string.
 */
export async function hashImageBlock(block: ContentBlock): Promise<string> {
  const json = JSON.stringify(block);
  const data = new TextEncoder().encode(json);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Store the vision model's response text, keyed by each image block's hash.
 * Called after the vision model finishes responding.
 */
export function storeImageSummary(imageHashes: string[], responseText: string): void {
  for (const hash of imageHashes) {
    cache.set(hash, responseText);
  }
}

/**
 * Retrieve the cached description for a given image hash.
 * Returns undefined if not cached.
 */
export function getImageSummary(imageHash: string): string | undefined {
  return cache.get(imageHash);
}

/**
 * Clear all cached entries. Used for testing.
 */
export function clearCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/image-cache.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/image-cache.ts src/image-cache.test.ts
git commit -m "feat: add image-cache module for vision response caching"
```

---

## Task 3: Message Transform Module

**Files:**
- Create: `src/transform.ts`
- Create: `src/transform.test.ts`

### Context

`transformMessagesForTextModel` takes a messages array and returns a new array where every `type: "image"` content block is replaced with a text block:

- Cache hit → `{ type: "text", text: "[图片描述: <cached text>]" }`
- Cache miss → `{ type: "text", text: "[image]" }`

The function is async because it calls `hashImageBlock` (which uses Web Crypto). It must not mutate the original messages array or any of its nested objects.

- [ ] **Step 1: Write failing tests in `src/transform.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "bun:test";

import { transformMessagesForTextModel } from "./transform";
import { storeImageSummary, clearCache, hashImageBlock } from "./image-cache";
import type { Message, ContentBlock } from "./types";

describe("transformMessagesForTextModel", () => {
  beforeEach(() => {
    clearCache();
  });

  it("returns messages unchanged when no image blocks exist", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      {
        role: "user",
        content: [{ type: "text", text: "a text block" }],
      },
    ];
    const result = await transformMessagesForTextModel(messages);
    expect(result).toEqual(messages);
  });

  it("replaces image block with cached description when available", async () => {
    const imageBlock: ContentBlock = {
      type: "image",
      source: { type: "base64", data: "test-data" },
    };
    const hash = await hashImageBlock(imageBlock);
    storeImageSummary([hash], "代码第12行有空指针问题");

    const messages: Message[] = [
      {
        role: "user",
        content: [
          imageBlock,
          { type: "text", text: "看看这段代码" },
        ],
      },
    ];
    const result = await transformMessagesForTextModel(messages);
    expect(result[0].content).toEqual([
      { type: "text", text: "[图片描述: 代码第12行有空指针问题]" },
      { type: "text", text: "看看这段代码" },
    ]);
  });

  it("replaces image block with [image] placeholder when not cached", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "uncached" } },
          { type: "text", text: "what is this?" },
        ],
      },
    ];
    const result = await transformMessagesForTextModel(messages);
    expect(result[0].content).toEqual([
      { type: "text", text: "[image]" },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("replaces all image blocks across multiple messages", async () => {
    const img1: ContentBlock = { type: "image", source: { type: "base64", data: "img1" } };
    const img2: ContentBlock = { type: "image", source: { type: "base64", data: "img2" } };
    const hash1 = await hashImageBlock(img1);
    storeImageSummary([hash1], "第一张图描述");

    const messages: Message[] = [
      { role: "user", content: [img1, { type: "text", text: "看看这个" }] },
      { role: "assistant", content: "好的" },
      { role: "user", content: [img2, { type: "text", text: "再看这个" }] },
    ];
    const result = await transformMessagesForTextModel(messages);

    // First message: img1 has cache hit
    expect(result[0].content).toEqual([
      { type: "text", text: "[图片描述: 第一张图描述]" },
      { type: "text", text: "看看这个" },
    ]);
    // Assistant message unchanged
    expect(result[1].content).toBe("好的");
    // Third message: img2 has cache miss → placeholder
    expect(result[2].content).toEqual([
      { type: "text", text: "[image]" },
      { type: "text", text: "再看这个" },
    ]);
  });

  it("does not mutate the original messages array", async () => {
    const imageBlock: ContentBlock = {
      type: "image",
      source: { type: "base64", data: "immutable-test" },
    };
    const messages: Message[] = [
      {
        role: "user",
        content: [imageBlock, { type: "text", text: "keep me" }],
      },
    ];
    const originalContent = messages[0].content;
    await transformMessagesForTextModel(messages);
    expect(messages[0].content).toBe(originalContent);
    expect(Array.isArray(messages[0].content) && messages[0].content[0].type).toBe("image");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/transform.test.ts`
Expected: Fails — module `./transform` does not exist.

- [ ] **Step 3: Implement `src/transform.ts`**

```typescript
import type { Message, ContentBlock } from "./types";
import { hashImageBlock, getImageSummary } from "./image-cache";

/**
 * Replace image blocks in messages with cached text descriptions.
 * Returns a new messages array (does not mutate the original).
 *
 * For each image block found:
 *   - Cache hit → { type: "text", text: "[图片描述: <cached text>]" }
 *   - Cache miss → { type: "text", text: "[image]" }
 */
export async function transformMessagesForTextModel(
  messages: Message[],
): Promise<Message[]> {
  const result: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg);
      continue;
    }

    const transformedContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === "image") {
        const hash = await hashImageBlock(block);
        const summary = getImageSummary(hash);
        transformedContent.push(
          summary
            ? { type: "text", text: `[图片描述: ${summary}]` }
            : { type: "text", text: "[image]" },
        );
      } else {
        transformedContent.push(block);
      }
    }

    result.push({ ...msg, content: transformedContent });
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/transform.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/transform.ts src/transform.test.ts
git commit -m "feat: add transform module for replacing image blocks with text"
```

---

## Task 4: Proxy Integration

**Files:**
- Modify: `src/proxy.ts:1-132`

### Context

This is the core integration task. `proxy.ts` gains two new behaviors:

1. **When `match.supportsImages === true`**: After sending the request, tee the response stream. Return one branch to the client immediately. In the background, read the other branch to accumulate text from SSE `content_block_delta` events, then cache it against the image block hashes from the request.

2. **When `match.supportsImages === false`**: Before building the upstream request, call `transformMessagesForTextModel(messages)` to replace image blocks in the body. Then proceed as normal.

Two helper functions are added to `proxy.ts`:
- `extractImageHashes(messages)` — hash all image blocks in the message array
- `captureStreamForCache(stream, imageHashes, isStreaming)` — read a stream branch in the background and cache the accumulated text

- [ ] **Step 1: Write the test for `extractImageHashes` behavior**

Add an integration test that verifies the proxy correctly strips image blocks for text-only models. Create `src/proxy.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";

import { hashImageBlock, storeImageSummary, clearCache } from "./image-cache";
import { transformMessagesForTextModel } from "./transform";
import type { Message, ContentBlock } from "./types";

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

    // Image block replaced with cached description
    expect(transformed[0].content).toEqual([
      { type: "text", text: "[图片描述: 图中显示了一个登录表单]" },
      { type: "text", text: "看看这个截图" },
    ]);
    // Assistant and subsequent user messages preserved
    expect(transformed[1].content).toBe("我看到了一个登录表单");
    expect(transformed[2].content).toBe("帮我写一个登录组件");
  });

  it("uses [image] placeholder when cache is empty", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "no-cache" } },
        ],
      },
      { role: "user", content: "继续" },
    ];

    const transformed = await transformMessagesForTextModel(messages);
    expect(transformed[0].content).toEqual([{ type: "text", text: "[image]" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (transform already works from Task 3)**

Run: `bun test src/proxy.test.ts`
Expected: Passes — these tests exercise the transform module which is already implemented.

- [ ] **Step 3: Add helper functions and modify `proxy.ts`**

Add two new imports at the top of `src/proxy.ts`:

```typescript
import * as config from "./config";
import { logRequest } from "./logger";
import { matchRule } from "./router";
import { hashImageBlock, storeImageSummary } from "./image-cache";
import { transformMessagesForTextModel } from "./transform";
import type { Message, Upstream } from "./types";
```

Add two helper functions after the `buildUpstreamRequest` function (before `buildProxyHandler`):

```typescript
/**
 * Hash all image blocks found across all messages.
 * Returns an array of hex-encoded SHA-256 hashes.
 */
async function extractImageHashes(messages: Message[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") {
          hashes.push(await hashImageBlock(block));
        }
      }
    }
  }
  return hashes;
}

/**
 * Read a tee'd response stream branch in the background to accumulate
 * text content, then cache it under the given image hashes.
 * Handles both SSE streaming and JSON non-streaming responses.
 * Errors are silently swallowed — caching failure only means a cache miss later.
 */
function captureStreamForCache(
  stream: ReadableStream<Uint8Array>,
  imageHashes: string[],
  isStreaming: boolean,
): void {
  if (isStreaming) {
    stream
      .pipeThrough(new TextDecoderStream())
      .pipeTo(
        new WritableStream<string>({
          write(chunk, controller) {
            const accumulated = (controller as { _accumulated?: string })._accumulated ?? "";
            (controller as { _accumulated?: string })._accumulated = accumulated + chunk;
          },
          close(controller) {
            const text = (controller as { _accumulated?: string })._accumulated ?? "";
            const extracted = extractTextFromSSE(text);
            if (extracted && imageHashes.length > 0) {
              storeImageSummary(imageHashes, extracted);
            }
          },
        }),
      )
      .catch(() => {});
  } else {
    stream
      .pipeThrough(new TextDecoderStream())
      .pipeTo(
        new WritableStream<string>({
          write(chunk, controller) {
            const accumulated = (controller as { _accumulated?: string })._accumulated ?? "";
            (controller as { _accumulated?: string })._accumulated = accumulated + chunk;
          },
          close(controller) {
            const text = (controller as { _accumulated?: string })._accumulated ?? "";
            try {
              const json = JSON.parse(text);
              const extracted = extractTextFromJsonResponse(json);
              if (extracted && imageHashes.length > 0) {
                storeImageSummary(imageHashes, extracted);
              }
            } catch {
              // Not valid JSON, skip caching
            }
          },
        }),
      )
      .catch(() => {});
  }
}

/**
 * Parse SSE-formatted text and extract concatenated text_delta content.
 */
function extractTextFromSSE(sseText: string): string {
  const lines = sseText.split("\n");
  let text = "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text;
      }
    } catch {
      // Skip malformed JSON lines
    }
  }
  return text;
}

/**
 * Extract text from a non-streaming API response body.
 */
function extractTextFromJsonResponse(json: Record<string, unknown>): string {
  if (!Array.isArray(json.content)) return "";
  return json.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}
```

Modify the `buildProxyHandler` function. Replace the body from the current line 66–88 block with the new logic that handles both paths. Here is the complete updated `buildProxyHandler`:

```typescript
export function buildProxyHandler(): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const startTime = Date.now();
    let body: Record<string, unknown> | null = null;

    try {
      const cfg = config.readConfig();
      const url = new URL(req.url);
      const BODY_METHODS = ["POST", "PUT", "PATCH"];
      const hasBody = BODY_METHODS.includes(req.method);
      let messages: Message[] = [];

      if (hasBody) {
        body = (await req.json()) as Record<string, unknown>;
        messages = (body.messages as Message[]) || [];
      }

      const match = matchRule(messages, cfg.rules, cfg.upstreams);

      if (!match) {
        return Response.json(
          { error: { message: "没有匹配的路由规则" } },
          { status: 502 },
        );
      }

      // Transform messages for models that don't support images
      let requestMessages = messages;
      if (hasBody && !match.supportsImages) {
        requestMessages = await transformMessagesForTextModel(messages);
        body = { ...body, messages: requestMessages };
      }

      const upstreamReq = buildUpstreamRequest(
        req.method,
        url.pathname + url.search,
        req.headers,
        body,
        match.upstream,
        hasBody ? match.model : null,
      );

      const upstreamRes = await fetch(upstreamReq);
      const duration = Date.now() - startTime;

      logRequest({
        method: req.method,
        path: url.pathname,
        status: upstreamRes.status,
        durationMs: duration,
        rule: match.ruleName,
        upstream: match.upstream.name,
        model: match.model,
        requestHeaders: req.headers,
        requestBody: body,
        responseHeaders: upstreamRes.headers,
      });

      // Full transparency: pass through status, headers, and streaming body
      const responseHeaders = new Headers(upstreamRes.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");

      // Capture response text for caching when the model supports images
      if (hasBody && match.supportsImages && upstreamRes.body) {
        const imageHashes = await extractImageHashes(messages);
        if (imageHashes.length > 0) {
          const [clientStream, cacheStream] = upstreamRes.body.tee();
          const isStreaming =
            responseHeaders.get("content-type")?.includes("text/event-stream") ?? false;
          captureStreamForCache(cacheStream, imageHashes, isStreaming);
          return new Response(clientStream, {
            status: upstreamRes.status,
            headers: responseHeaders,
          });
        }
      }

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知代理错误";
      const duration = Date.now() - startTime;

      logRequest({
        method: req.method,
        path: new URL(req.url).pathname,
        status: 502,
        durationMs: duration,
        error: message,
        requestHeaders: req.headers,
        requestBody: body,
      });

      return Response.json({ error: { message: `代理错误：${message}` } }, { status: 502 });
    }
  };
}
```

- [ ] **Step 4: Run all tests to verify nothing is broken**

Run: `bun test`
Expected: All tests pass — router, image-cache, transform, and proxy integration tests.

- [ ] **Step 5: Run lint to verify no issues**

Run: `pnpm lint`
Expected: No errors. Fix any warnings if present.

- [ ] **Step 6: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat: integrate image caching and message transform into proxy"
```

---

## Task 5: Config & Frontend

**Files:**
- Modify: `config.example.json:1-30`
- Modify: `web/src/pages/Rules.tsx`

### Context

The config example needs `supportsImages` added to both rules so users see the field when creating new configs. The frontend rule form needs a Switch/toggle for `supportsImages`, and the table should show the value.

The API layer (`src/api.ts`) does **not** need changes — it already spreads `Omit<Rule, "id">` / `Partial<Rule>` which naturally passes through any field.

- [ ] **Step 1: Update `config.example.json`**

Add `supportsImages` to both example rules:

```json
{
  "port": 9191,
  "upstreams": [
    {
      "id": "anthropic-default",
      "name": "Anthropic Official",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-xxx",
      "authScheme": "x-api-key"
    }
  ],
  "rules": [
    {
      "id": "image-rule",
      "name": "Image Messages",
      "condition": "has_image",
      "upstreamId": "anthropic-default",
      "model": "claude-opus-4-6",
      "priority": 1,
      "supportsImages": true
    },
    {
      "id": "default-rule",
      "name": "Default",
      "condition": "default",
      "upstreamId": "anthropic-default",
      "model": "claude-sonnet-4-6",
      "priority": 999,
      "supportsImages": false
    }
  ]
}
```

- [ ] **Step 2: Update `web/src/pages/Rules.tsx` — form interface and defaults**

Add `Switch` to the antd imports:

```typescript
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  App,
  Typography,
  Switch,
} from "antd";
```

Update the `FormValues` interface to include `supportsImages`:

```typescript
interface FormValues {
  name: string;
  condition: RuleCondition;
  upstreamId: string;
  model: string;
  priority: number;
  supportsImages: boolean;
}
```

Update `EMPTY_FORM` to include `supportsImages: false`:

```typescript
const EMPTY_FORM: FormValues = {
  name: "",
  condition: "default",
  upstreamId: "",
  model: "",
  priority: 100,
  supportsImages: false,
};
```

- [ ] **Step 3: Update `web/src/pages/Rules.tsx` — `openEditModal` function**

Add `supportsImages` to the form values when editing:

```typescript
  function openEditModal(rule: Rule) {
    setEditingId(rule.id);
    form.setFieldsValue({
      name: rule.name,
      condition: rule.condition,
      upstreamId: rule.upstreamId,
      model: rule.model,
      priority: rule.priority,
      supportsImages: rule.supportsImages ?? false,
    });
    setModalOpen(true);
  }
```

- [ ] **Step 4: Update `web/src/pages/Rules.tsx` — add Switch to the modal form**

Add a `Form.Item` for `supportsImages` in the Modal's `<Form>` JSX, after the `priority` field and before the submit button. Read the existing file first to find the exact location, then add:

```tsx
<Form.Item
  name="supportsImages"
  label="支持图片"
  valuePropName="checked"
  tooltip="启用后，图片内容将直接传递给模型；关闭时，历史中的图片会被替换为文字描述"
>
  <Switch />
</Form.Item>
```

- [ ] **Step 5: Update `web/src/pages/Rules.tsx` — add column to the table**

Add a column to the table's `columns` definition to display the `supportsImages` status. Find the columns array (look for `const columns: ColumnsType<Rule>`) and add before the action column:

```typescript
{
  title: "图片支持",
  dataIndex: "supportsImages",
  key: "supportsImages",
  render: (val: boolean | undefined) =>
    val ? <Tag color="blue">支持</Tag> : <Tag>不支持</Tag>,
},
```

- [ ] **Step 6: Verify the frontend builds**

Run: `cd web && pnpm build`
Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add config.example.json web/src/pages/Rules.tsx
git commit -m "feat: add supportsImages to config example and frontend rule form"
```

---

## Task 6: Final Verification

**Files:** None (verification only)

### Context

Run the full test suite, linter, and formatter to confirm everything is clean. This catches any cross-module issues that individual task test runs might miss.

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass across `router.test.ts`, `image-cache.test.ts`, `transform.test.ts`, `proxy.test.ts`.

- [ ] **Step 2: Run linter**

Run: `pnpm lint`
Expected: No errors.

- [ ] **Step 3: Run formatter check**

Run: `pnpm format:check`
Expected: No formatting issues. If issues found, run `pnpm format` to fix.

- [ ] **Step 4: Build frontend**

Run: `cd web && pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Manual integration test**

Start the proxy server and verify the full flow:

```bash
pnpm dev
```

Then using a client pointed at `http://localhost:9191`:

1. Send a message with an image → should route to the multimodal model (supportsImages: true), response streams back normally
2. Send a follow-up text-only message → should route to the text-only model (supportsImages: false), no 400 error, the response should demonstrate awareness of the previous image context
3. Verify in logs that both requests succeeded with 200 status

- [ ] **Step 6: Final commit (if any format fixes were applied)**

```bash
git add -A
git commit -m "chore: format and lint fixes after image context preservation feature"
```
