/**
 * Parse SSE-formatted text and extract concatenated text_delta content.
 */
export function extractTextFromSSE(sseText: string): string {
  const lines = sseText.split("\n");
  let text = "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
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
export function extractTextFromJsonResponse(json: Record<string, unknown>): string {
  if (!Array.isArray(json.content)) return "";
  return json.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text ?? "")
    .join("");
}
