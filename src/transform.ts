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
