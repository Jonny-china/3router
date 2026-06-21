import { collectImageBlocks, hashImageBlock, getImageSummary } from "./image-cache";
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
  const imageBlocks = collectImageBlocks(messages);
  const hashes = await Promise.all(imageBlocks.map(hashImageBlock));

  // Build a lookup from block identity → cached summary.
  // phase1 与 phase2 遍历同一 messages，block 是同一对象引用，用身份做键即可，
  // 省掉 phase1/phase2 各一次 JSON.stringify（hashImageBlock 内那次仍保留，SHA-256 需要）。
  const summaryMap = new Map<ContentBlock, string | undefined>();
  imageBlocks.forEach((block, i) => {
    summaryMap.set(block, getImageSummary(hashes[i]));
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
        const summary = summaryMap.get(block);
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
