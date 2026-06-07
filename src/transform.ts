import { hashImageBlock, getImageSummary } from "./image-cache";
import type { Message, ContentBlock } from "./types";

/**
 * Replace image blocks in messages with cached text descriptions.
 * Returns a new messages array (does not mutate the original).
 *
 * For each image block found:
 *   - Cache hit → { type: "text", text: "[图片描述: <cached text>]" }
 *   - Cache miss → { type: "text", text: "[image]" }
 */
export async function transformMessagesForTextModel(messages: Message[]): Promise<Message[]> {
  // Phase 1: collect all image blocks and hash in parallel
  const imageBlocks: ContentBlock[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") imageBlocks.push(block);
      }
    }
  }
  const hashes = await Promise.all(imageBlocks.map(hashImageBlock));

  // Build a lookup from serialized block → cached summary
  const summaryMap = new Map<string, string | undefined>();
  imageBlocks.forEach((block, i) => {
    summaryMap.set(JSON.stringify(block), getImageSummary(hashes[i]));
  });

  // Phase 2: build transformed messages using pre-computed summaryMap
  const result: Message[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg);
      continue;
    }

    const transformedContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === "image") {
        const summary = summaryMap.get(JSON.stringify(block));
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
