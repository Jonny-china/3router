import { describe, it, expect } from "bun:test";
import { extractTextFromSSE, extractTextFromJsonResponse } from "./stream-parser";

describe("extractTextFromSSE", () => {
  it("concatenates text from multiple SSE events", () => {
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
    ].join("\n");

    expect(extractTextFromSSE(sse)).toBe("Hello world");
  });

  it("handles data: without trailing space", () => {
    const sse = 'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"no-space"}}';
    expect(extractTextFromSSE(sse)).toBe("no-space");
  });

  it("skips the [DONE] sentinel", () => {
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}',
      "data: [DONE]",
    ].join("\n");

    expect(extractTextFromSSE(sse)).toBe("done");
  });

  it("skips malformed JSON lines without crashing", () => {
    const sse = [
      "data: {not valid json}",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
      "data: ",
    ].join("\n");

    expect(extractTextFromSSE(sse)).toBe("ok");
  });
});

describe("extractTextFromJsonResponse", () => {
  it("extracts text from a standard response", () => {
    const json = {
      content: [
        { type: "text", text: "First " },
        { type: "image" },
        { type: "text", text: "second" },
      ],
    };

    expect(extractTextFromJsonResponse(json)).toBe("First second");
  });

  it("returns empty string when text field is missing (not 'undefined')", () => {
    const json = {
      content: [{ type: "text" }],
    };

    expect(extractTextFromJsonResponse(json)).toBe("");
  });

  it("returns empty string for non-array content", () => {
    const json = { content: "plain string" };
    expect(extractTextFromJsonResponse(json)).toBe("");
  });
});
