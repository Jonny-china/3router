import { describe, it, expect, beforeEach } from "bun:test";

import { storeImageSummary, clearCache, hashImageBlock } from "./image-cache";
import { transformMessagesForTextModel } from "./transform";
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
        content: [imageBlock, { type: "text", text: "看看这段代码" }],
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
