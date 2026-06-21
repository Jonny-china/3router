import type { ContentBlock, Message } from "./types";

const cache = new Map<string, string>();

/**
 * Collect all image content blocks across messages (in encounter order).
 * Shared by transform.ts（替换为缓存描述）与 proxy.ts（hash 作缓存键），
 * 消除两处逐字重复的遍历逻辑。router.ts 的 hasImage 是"仅最后一条 user 消息"的刻意窄化，不共用。
 */
export function collectImageBlocks(messages: Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "image") blocks.push(block);
      }
    }
  }
  return blocks;
}

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
