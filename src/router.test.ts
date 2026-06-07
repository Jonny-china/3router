import { describe, it, expect } from "bun:test";

import { matchRule } from "./router";
import type { Upstream, Rule, Message } from "./types";

const upstreams: Upstream[] = [
  { id: "up-1", name: "Main", baseUrl: "https://api.main.com", apiKey: "key-1" },
  { id: "up-2", name: "Secondary", baseUrl: "https://api.sec.com", apiKey: "key-2" },
];

const rules: Rule[] = [
  {
    id: "img",
    name: "Image",
    condition: "has_image",
    upstreamId: "up-1",
    model: "claude-opus-4-6",
    priority: 1,
  },
  {
    id: "def",
    name: "Default",
    condition: "default",
    upstreamId: "up-2",
    model: "claude-sonnet-4-6",
    priority: 999,
  },
];

describe("matchRule", () => {
  it("matches has_image rule when user message contains image blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "abc" } },
          { type: "text", text: "What is this?" },
        ],
      },
    ];
    const result = matchRule(messages, rules, upstreams);
    expect(result?.model).toBe("claude-opus-4-6");
    expect(result?.upstream.id).toBe("up-1");
  });

  it("matches default rule when user message has text-only content array", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];
    const result = matchRule(messages, rules, upstreams);
    expect(result?.model).toBe("claude-sonnet-4-6");
    expect(result?.upstream.id).toBe("up-2");
  });

  it("matches default rule when user message has string content", () => {
    const messages: Message[] = [{ role: "user", content: "Hello" }];
    const result = matchRule(messages, rules, upstreams);
    expect(result?.model).toBe("claude-sonnet-4-6");
    expect(result?.upstream.id).toBe("up-2");
  });

  it("matches default rule when last message is assistant", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "abc" } }],
      },
      { role: "assistant", content: "I see an image." },
    ];
    const result = matchRule(messages, rules, upstreams);
    expect(result?.model).toBe("claude-sonnet-4-6");
    expect(result?.upstream.id).toBe("up-2");
  });

  it("sorts rules by priority ascending (lowest number wins)", () => {
    const priorityRules: Rule[] = [
      {
        id: "low",
        name: "Low Priority Default",
        condition: "default",
        upstreamId: "up-2",
        model: "model-low",
        priority: 999,
      },
      {
        id: "high",
        name: "High Priority Default",
        condition: "default",
        upstreamId: "up-1",
        model: "model-high",
        priority: 1,
      },
    ];
    const messages: Message[] = [{ role: "user", content: "test" }];
    const result = matchRule(messages, priorityRules, upstreams);
    expect(result?.model).toBe("model-high");
    expect(result?.upstream.id).toBe("up-1");
  });

  it("returns undefined when no rules match", () => {
    const emptyRules: Rule[] = [
      {
        id: "img",
        name: "Image Only",
        condition: "has_image",
        upstreamId: "up-1",
        model: "claude-opus-4-6",
        priority: 1,
      },
    ];
    const messages: Message[] = [{ role: "user", content: "text only" }];
    const result = matchRule(messages, emptyRules, upstreams);
    expect(result).toBeUndefined();
  });

  it("returns undefined when upstream referenced by rule doesn't exist", () => {
    const badRules: Rule[] = [
      {
        id: "def",
        name: "Default",
        condition: "default",
        upstreamId: "nonexistent",
        model: "some-model",
        priority: 1,
      },
    ];
    const messages: Message[] = [{ role: "user", content: "test" }];
    const result = matchRule(messages, badRules, upstreams);
    expect(result).toBeUndefined();
  });

  it("uses the last message in the array for routing", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      { role: "assistant", content: "response" },
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "xyz" } }],
      },
    ];
    const result = matchRule(messages, rules, upstreams);
    expect(result?.model).toBe("claude-opus-4-6");
  });
});
