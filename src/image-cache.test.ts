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
