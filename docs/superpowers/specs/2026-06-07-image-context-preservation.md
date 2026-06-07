# Image Context Preservation for Text-Only Models

> When routing to a text-only model, replace image blocks in conversation history with cached descriptions from the multimodal model's previous response.

## 1. Problem

3router uses two models: a **multimodal model** (good at image recognition) and a **text-only model** (good at coding). The routing rule checks only the last message — if it contains images, route to the multimodal model; otherwise route to the text-only model.

**The problem**: The text-only model receives the full conversation history, which may contain image blocks from earlier messages. If the text-only model doesn't support image content blocks, the upstream API returns a 400 error:

```
"Unexpected item type in content."
```

### Typical Flow That Breaks

```
[User] "看看这段代码有没有 bug" + [image block]        ← routes to multimodal model
[Assistant] "第12行有空指针问题，data 可能是 null..."    ← multimodal model's text response

[User] "帮我修复它"                                     ← routes to text-only model
  ↓ text-only model receives full history including [image block]
  ↓ 400 ERROR: "Unexpected item type in content"
```

## 2. Solution: Explicit Capability + Vision-Response-as-Summary

Two-part solution:

### Part 1: Explicit `supportsImages` on Rule

Add a `supportsImages` boolean field to the Rule configuration. This makes model capabilities explicit rather than inferred from the routing condition.

```jsonc
{
  "rules": [
    {
      "name": "Image Messages",
      "condition": "has_image",
      "model": "qwen3.6-plus",       // multimodal model
      "supportsImages": true,         // ← explicit
      ...
    },
    {
      "name": "Default",
      "condition": "default",
      "model": "qwen3.7-max",        // text-only model
      "supportsImages": false,        // ← explicit
      ...
    }
  ]
}
```

**Why not infer from condition?** Using `condition === "default"` to imply "text-only" is fragile. A user might have multiple rules with different conditions, or misconfigure a model. Explicit declaration is defensive and extensible.

### Part 2: Cache Vision Model Response as Summary

The multimodal model's response is already a textual description of the image. We capture this response and use it to replace image blocks when the conversation is later routed to a model with `supportsImages: false`.

### Key Insight

No extra API calls are needed. The multimodal model has already "seen" the image and described it in text. We just cache that description.

### Improved Flow

```
[User] "看看这段代码有没有 bug" + [image block]        ← routes to model (supportsImages: true)
[Assistant] "第12行有空指针问题，data 可能是 null..."    ← captured and cached

[User] "帮我修复它"                                     ← routes to model (supportsImages: false)
  ↓ image block replaced with: "[图片描述: 第12行有空指针问题，data 可能是 null...]"
  ↓ text-only model receives clean text-only history
  ↓ ✅ works correctly
```

## 3. Architecture

```
                        ┌─────────────────────────┐
                        │      image-cache.ts      │
                        │                          │
                        │  Map<imageHash, string>  │
                        │                          │
                        │  - storeImageSummary()   │
                        │  - getImageSummary()     │
                        │  - hashImageBlock()      │
                        └──────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
     ┌────────▼────────┐  ┌───────▼────────┐  ┌────────▼──────────┐
     │   Request path  │  │  Response path │  │ Transform path    │
     │                 │  │  (streaming)   │  │                   │
     │ supportsImages  │  │ Capture SSE    │  │ supportsImages    │
     │   === true?     │  │ → accumulate   │  │   === false?      │
     │ → hash blocks   │  │   text deltas  │  │ → replace image   │
     │ → store keys    │  │ → cache on     │  │   blocks with     │
     │   for later     │  │   stream end   │  │   cached desc     │
     │                 │  │                │  │                   │
     └─────────────────┘  └────────────────┘  └───────────────────┘
```

## 4. Data Structures

### Rule Type Change (`types.ts`)

Add `supportsImages` as an optional boolean field on `Rule`:

```typescript
interface Rule {
  id: string
  name: string
  condition: RuleCondition
  upstreamId: string
  model: string
  priority: number
  supportsImages?: boolean  // ← new field, defaults to false when undefined
}
```

**Default behavior**: When `supportsImages` is undefined (e.g., old configs without this field), it defaults to `false`. This is safe — stripping image blocks from an unknown model is better than crashing with a 400 error.

### config.json Example

```jsonc
{
  "rules": [
    {
      "id": "image-rule",
      "name": "Image Messages",
      "condition": "has_image",
      "upstreamId": "...",
      "model": "qwen3.6-plus",
      "priority": 1,
      "supportsImages": true
    },
    {
      "id": "default-rule",
      "name": "Default",
      "condition": "default",
      "upstreamId": "...",
      "model": "qwen3.7-max",
      "priority": 999,
      "supportsImages": false
    }
  ]
}
```

### config.example.json

Updated to include `supportsImages` in both example rules.

### RouteMatch Change

`RouteMatch` (returned by `matchRule`) needs to carry the `supportsImages` flag so `proxy.ts` can decide whether to transform messages:

```typescript
interface RouteMatch {
  upstream: Upstream
  model: string
  ruleName: string
  supportsImages: boolean  // ← new field, copied from the matched rule
}
```

### Cache Key

SHA-256 hash of the JSON-serialized image content block.

```typescript
// Input: { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR..." } }
// Hash: SHA-256 of JSON.stringify(block)
```

Image blocks are immutable within a single conversation — once the user sends an image, the client replays the same block in subsequent turns. The hash is stable for the lifetime of the conversation.

### Cache Value

Concatenated text from the multimodal model's response for that request.

```typescript
// Example: "第12行有空指针问题，data 变量可能是 null，建议加一个 null check"
```

### Cache Storage

In-memory `Map<string, string>`. No persistence needed.

- Cache misses (e.g., after process restart) gracefully fall back to `[image]` placeholder
- No eviction needed — typical conversations contain 1–5 images, well within memory limits
- Process-scoped lifetime matches the use case: caches are only useful within a single conversation session

## 5. Module Design

### New File: `src/image-cache.ts`

```typescript
/**
 * In-memory cache mapping image block hashes to vision model response text.
 * Used to replace image blocks with text descriptions when routing to
 * text-only models that don't support image content.
 */

/**
 * Compute SHA-256 hash of a content block for use as cache key.
 */
export async function hashImageBlock(block: ContentBlock): Promise<string>

/**
 * Store the vision model's response text, keyed by each image block's hash.
 * Called after the vision model finishes responding.
 */
export function storeImageSummary(
  imageHashes: string[],
  responseText: string,
): void

/**
 * Retrieve the cached description for a given image hash.
 * Returns undefined if not cached (e.g., image just sent, no response yet).
 */
export function getImageSummary(imageHash: string): string | undefined
```

### New File: `src/transform.ts`

```typescript
/**
 * Transform conversation messages for text-only models by replacing
 * image content blocks with cached text descriptions.
 */

/**
 * Replace image blocks in messages with cached descriptions.
 * Returns a new messages array (does not mutate the original).
 *
 * For each image block found:
 *   - Cache hit → replace with { type: "text", text: "[图片描述: <cached text>]" }
 *   - Cache miss → replace with { type: "text", text: "[image]" }
 *
 * Text blocks and string content are preserved unchanged.
 */
export function transformMessagesForTextModel(
  messages: Message[],
): Promise<Message[]>
```

### Modified File: `src/proxy.ts`

Two new responsibilities:

1. **When `match.supportsImages === true`**: Capture the response stream to extract text, then cache it against the image hashes from the request.
2. **When `match.supportsImages === false`**: Transform messages before building the upstream request — replace image blocks with cached descriptions.

### Modified File: `src/router.ts`

`matchRule` returns `supportsImages` in the `RouteMatch`:

```typescript
return {
  upstream,
  model: matchedRule.model,
  ruleName: matchedRule.name,
  supportsImages: matchedRule.supportsImages ?? false,
}
```

### Modified File: `src/config.ts`

No validation changes needed. `supportsImages` is optional — old configs without it default to `false`.

### Modified File: `src/api.ts` + Web Frontend

Add `supportsImages` as a checkbox/toggle in the Rule creation/edit form so users can configure it via the GUI.

## 6. Detailed Flow

### 6.1 Image-Capable Model (`match.supportsImages === true`)

```
1. matchRule returns rule with supportsImages: true
2. Before sending request:
   a. Find all image blocks in messages
   b. Compute hash for each image block
   c. Store hashes in local variable: imageHashes[]
3. Send request to upstream (image blocks pass through unchanged)
4. Response comes back (SSE streaming):
   a. Tee the response stream: one branch → client, one branch → accumulator
   b. Accumulator reads SSE events in background (non-blocking):
      - Parse "content_block_delta" events
      - Extract delta.text from each event
      - Concatenate all text
   c. On stream end ([DONE] or error):
      - Call storeImageSummary(imageHashes, accumulatedText)
   d. Client branch passes through unchanged
5. Return client branch as response
```

### 6.2 Text-Only Model (`match.supportsImages === false`)

```
1. matchRule returns rule with supportsImages: false (or undefined → defaults to false)
2. Before sending request:
   a. Call transformMessagesForTextModel(messages)
   b. For each message with content array:
      - For each block with type === "image":
        - Compute hash of the block
        - Look up cached description via getImageSummary(hash)
        - Replace with text block containing description or placeholder
   c. Use transformed messages in the upstream request body
3. Send request to upstream (no image blocks in request, no stream capture needed)
4. Return response as-is
```

### 6.3 Streaming SSE Parsing

The accumulator reads the upstream response stream in the background. It parses SSE format to extract text content:

```
SSE event format:
  event: content_block_delta
  data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"some text"}}

Accumulator logic:
  1. Read each line from the stream
  2. If line starts with "data:" and is not "data: [DONE]"
  3. Parse JSON from the data portion
  4. If type === "content_block_delta" and delta.type === "text_delta"
  5. Append delta.text to accumulated string
```

**Non-blocking**: The accumulator runs via `.pipeTo()` or async iteration in a fire-and-forget pattern. It never delays the response to the client. If parsing fails for any reason, it silently skips caching — the only consequence is a cache miss on the next request (falls back to `[image]` placeholder).

### 6.4 Non-Streaming Response Handling

If the multimodal model returns a non-streaming response (no SSE), extract text from the response JSON:

```
1. Clone the response (response.clone()) before returning
2. Parse cloned response body as JSON
3. Extract text from response.content[].text blocks
4. Store in cache
```

This is a secondary path — most API calls use streaming. Implementation can defer this if all upstreams use streaming.

## 7. Edge Cases

### Image sent but no response yet

If the user sends an image and immediately sends another message before the multimodal model responds, the cache won't have an entry yet.

**Behavior**: Replace with `[image]` placeholder. This is acceptable — the user would need to wait for the first response before continuing anyway.

### Multiple images in one message

Each image block is hashed and cached independently. A single vision model response is stored under all image hashes from that request.

**Example**:
```
[User] message contains [image1] [image2] + text
[Multimodal model] "The first image shows... The second image contains..."
Cache: hash(image1) → full response, hash(image2) → full response
```

The full response text is associated with each image. This is a simplification — ideally each image would get its own description, but the full response provides enough context for the text-only model to work with.

### Multiple images across multiple messages

Each image gets its own cache entry from its respective multimodal response:

```
[User] msg1: [image1] + "看这个"
[Assistant] "这是一段 React 代码..."        → cache(hash(image1)) = "这是一段 React 代码..."
[User] msg2: [image2] + "再看这个"
[Assistant] "这是一个 CSS 样式问题..."      → cache(hash(image2)) = "这是一个 CSS 样式问题..."
```

### Conversation with no images

`transformMessagesForTextModel` scans messages, finds no image blocks, returns the messages unchanged. Zero overhead.

### Process restart

Cache is in-memory only. After restart, all cached entries are lost. Subsequent requests will use `[image]` placeholders until the multimodal model processes images again. This is an acceptable tradeoff — no persistence infrastructure needed.

### Large images (base64)

Base64-encoded images can be several MB. SHA-256 hashing via `crypto.subtle.digest` is efficient enough — hashing 10MB of data takes ~10ms.

### Backward compatibility: `supportsImages` omitted

Old config files may not have the `supportsImages` field. The `router.ts` defaults it to `false` via `matchedRule.supportsImages ?? false`. This is the safe default — stripping image blocks from an unknown model prevents crashes. Users who want image passthrough must explicitly set `supportsImages: true`.

### `supportsImages: true` model receiving image history

If the target model supports images, image blocks pass through unchanged — no transformation, no caching overhead. This is the common path for multimodal models.

## 8. File Changes Summary

| File | Action | Changes |
|------|--------|---------|
| `src/image-cache.ts` | **New** | Cache store with `storeImageSummary`, `getImageSummary`, `hashImageBlock` |
| `src/transform.ts` | **New** | `transformMessagesForTextModel` — replaces image blocks with cached text |
| `src/types.ts` | **Modified** | Add `supportsImages?: boolean` to `Rule`; add `supportsImages: boolean` to `RouteMatch` |
| `src/router.ts` | **Modified** | Return `supportsImages` in `RouteMatch` |
| `src/proxy.ts` | **Modified** | Stream capture for `supportsImages: true`; message transform for `supportsImages: false` |
| `src/config.example.json` | **Modified** | Add `supportsImages` to example rules |
| `src/api.ts` | **Modified** | Handle `supportsImages` in rule CRUD endpoints |
| `web/` frontend | **Modified** | Add `supportsImages` toggle to rule form |
| `src/image-cache.test.ts` | **New** | Unit tests for cache operations and hashing |
| `src/transform.test.ts` | **New** | Unit tests for message transformation |
| `src/router.test.ts` | **Modified** | Add tests for `supportsImages` in `RouteMatch` |

**No changes to**: `config.ts`, `server.ts`, `logger.ts`.

## 9. Testing Plan

### Unit Tests: `image-cache.test.ts`

- `hashImageBlock` produces consistent hashes for the same block
- `hashImageBlock` produces different hashes for different blocks
- `storeImageSummary` + `getImageSummary` round-trips correctly
- `getImageSummary` returns `undefined` for unknown hashes
- Multiple images in one call stores under all hashes
- Overwriting an existing hash updates the value

### Unit Tests: `transform.test.ts`

- Messages with no image blocks pass through unchanged
- Image block with cached description → replaced with `[图片描述: ...]`
- Image block without cached description → replaced with `[image]`
- Multiple image blocks in one message all replaced
- String content messages pass through unchanged
- Text blocks within array content are preserved
- Original messages array is not mutated

### Unit Tests: `router.test.ts` (updated)

- `matchRule` returns `supportsImages: true` for rules that declare it
- `matchRule` returns `supportsImages: false` for rules that declare `false`
- `matchRule` returns `supportsImages: false` for rules that omit the field (backward compat)

### Integration Tests (manual)

1. Send image → multimodal model (`supportsImages: true`) responds → send follow-up text → text-only model (`supportsImages: false`) succeeds (no 400 error)
2. Send image without follow-up → text-only model receives `[image]` placeholder
3. Multi-turn: image → response → text → response → image → response → text (verifies cache across turns)
4. Restart process → cache miss → `[image]` placeholder used
5. Old config without `supportsImages` field → defaults to `false` → image blocks still stripped

## 10. Performance Considerations

- **Hashing**: SHA-256 via Web Crypto API. ~10ms for 10MB base64 image. Only computed on image blocks, not text.
- **Stream tee**: `ReadableStream.tee()` has negligible overhead — it creates two references to the same underlying stream.
- **Cache lookup**: O(1) Map lookup per image block during transformation.
- **Memory**: Each cache entry stores one string (vision model response, typically 100–2000 chars). Negligible memory footprint.
- **No API overhead**: Zero additional upstream calls. Caching piggybacks on existing responses.

## 11. Future Considerations (Out of Scope)

These are explicitly **not** part of this feature but could be added later:

- **Per-image descriptions**: Instead of storing the full response for all images, parse the response to attribute text segments to specific images.
- **Cache persistence**: Write cache to disk for survival across restarts.
- **Cache eviction**: LRU eviction for very long-running processes with many images.
- **Configurable placeholder**: Allow users to customize the `[image]` fallback text.
- **Support for other content types**: Extend the pattern to audio, video, or other multimodal content blocks.
