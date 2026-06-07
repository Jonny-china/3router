# 3router Design Spec

> Local Claude Code API proxy with intelligent routing — route requests to different upstreams/models based on message content.

## 1. Overview

3router is a local HTTP proxy that sits between Claude Code and upstream AI API endpoints. Claude Code points its `ANTHROPIC_BASE_URL` to `http://localhost:9191`, and 3router forwards requests to configured upstreams, applying routing rules based on whether the request contains image content.

### Use Case

- Messages containing images → route to a multimodal-capable model (e.g., `claude-opus-4-6`)
- Pure text messages → route to a default model (e.g., `claude-sonnet-4-6`)
- Both upstream and model are configurable per rule

## 2. Architecture

```
┌─────────────┐    ANTHROPIC_BASE_URL=http://localhost:9191    ┌──────────────┐
│  Claude Code │ ──────────────────────────────────────────────▶│  3router     │
│              │◀────────────────────────────────────────────── │  (Bun HTTP)  │
└─────────────┘                                                 └──────┬───────┘
                                                                       │
                                                          ┌────────────┼────────────┐
                                                          │            │            │
                                                    ┌─────▼─────┐ ┌───▼───┐ ┌─────▼─────┐
                                                    │ 上游 A    │ │上游 B │ │  Web GUI  │
                                                    │ Anthropic │ │其他   │ │ React+Vite│
                                                    │ API       │ │       │ │           │
                                                    └───────────┘ └───────┘ └───────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Language | TypeScript |
| HTTP Server | `Bun.serve()` (native, no framework) |
| Frontend | React + Vite |
| Config Storage | Local JSON file (`config.json`) |
| Package Manager | pnpm |

### Directory Structure

```
3router/
├── src/
│   ├── server.ts          # Entry point, Bun.serve()
│   ├── proxy.ts           # Proxy forwarding + SSE streaming
│   ├── router.ts          # Rule matching (pure function)
│   ├── config.ts          # config.json read/write
│   ├── api.ts             # Config management REST API
│   └── types.ts           # Type definitions
├── web/                   # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Upstreams.tsx
│   │   │   └── Rules.tsx
│   │   └── api.ts         # fetch wrappers
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── config.json            # Runtime config (gitignored)
├── config.example.json    # Example config
├── package.json
├── tsconfig.json
└── README.md
```

### Port Plan

- **Production**: Bun serves everything (API + static files) on port `9191`
- **Development**: Bun backend on `9191`, Vite dev server on `5173` (Vite proxies `/api/*` to backend)

## 3. Data Structures

### config.json

```jsonc
{
  "port": 9191,
  "upstreams": [
    {
      "id": "anthropic-default",
      "name": "Anthropic Official",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-xxx"
    }
  ],
  "rules": [
    {
      "id": "image-rule",
      "name": "Image Messages",
      "condition": "has_image",
      "upstreamId": "anthropic-default",
      "model": "claude-opus-4-6",
      "priority": 1
    },
    {
      "id": "default-rule",
      "name": "Default",
      "condition": "default",
      "upstreamId": "anthropic-default",
      "model": "claude-sonnet-4-6",
      "priority": 999
    }
  ]
}
```

### TypeScript Types

```typescript
interface Upstream {
  id: string
  name: string
  baseUrl: string
  apiKey: string
}

type RuleCondition = 'has_image' | 'default'

interface Rule {
  id: string
  name: string
  condition: RuleCondition
  upstreamId: string
  model: string
  priority: number  // Lower number = higher priority
}

interface Config {
  port: number
  upstreams: Upstream[]
  rules: Rule[]
}
```

## 4. Routing Logic

### Rule Matching (`router.ts`)

```
function matchRule(messages, rules, upstreams):
  1. Sort rules by priority ascending (lowest number first)
  2. Get the last message in the messages array
  3. If last message role === "user":
     - Check if its content array contains any block with type: "image"
     - If yes → match rule with condition === "has_image"
     - If no → match rule with condition === "default"
  4. If last message role !== "user" (e.g., assistant after tool_use):
     → match rule with condition === "default"
  5. Return { upstream, model }
```

### Known Limitation

When the last message is `assistant` (e.g., after a tool_use response), the request routes to the default model even if the conversation history contains image blocks. If the default model doesn't support multimodal input, the upstream may return an error. This is an accepted tradeoff — the user is responsible for ensuring their default model can handle conversation content, or for switching routes manually when needed.

## 5. Proxy & SSE Streaming

### Request Flow (`proxy.ts`)

```
async function proxyRequest(req, upstream, model):
  1. Parse request body JSON
  2. Replace body.model with the matched rule's model
  3. Construct upstream request:
     - URL: upstream.baseUrl + req.url path (e.g., /v1/messages)
     - Headers: copy all original headers, replace Authorization with upstream.apiKey
     - Body: modified JSON
  4. Send to upstream
  5. Return response with full transparency:
     - Status code: as-is from upstream
     - Response headers: all headers as-is from upstream
     - Body: ReadableStream piped directly, no buffering
```

### Full Transparency Guarantee

- **Request direction**: Only `Authorization` header and `model` body field are modified. All other headers and body fields pass through unchanged.
- **Response direction**: Status code, all response headers (`Content-Type`, custom `X-` headers, etc.), and body (including SSE event stream) are forwarded exactly as received.
- **No modification**: `Content-Length`, `Transfer-Encoding`, `Cache-Control`, etc. are not manually set — upstream values pass through directly.

### SSE Streaming

Bun's `fetch` returns `Response.body` as a `ReadableStream`. This is used directly as the body of the response sent back to Claude Code — natural streaming support with zero buffering.

## 6. Web GUI

### Layout

Sidebar navigation (not top tabs) for future extensibility. Two pages:

### Page 1: Upstreams (`Upstreams.tsx`)

- List all upstreams: name, base URL, API key (masked display: `sk-ant-***xxx`)
- Add/edit upstream form: name, baseUrl, apiKey
- Delete upstream (warn if associated rules exist)

### Page 2: Rules (`Rules.tsx`)

- List all rules sorted by priority: name, condition, target upstream, target model, priority
- Add/edit rule form: name, condition (dropdown: `has_image` / `default`), upstream (dropdown from configured upstreams), model (text input), priority
- Delete rule (must keep at least one `default` rule)

### API Endpoints

```
GET    /api/config          → Full config
PUT    /api/upstreams/:id   → Update upstream
POST   /api/upstreams       → Create upstream
DELETE /api/upstreams/:id   → Delete upstream
PUT    /api/rules/:id       → Update rule
POST   /api/rules           → Create rule
DELETE /api/rules/:id       → Delete rule
```

### Development vs Production

- **Development**: Vite dev server on `5173`, `vite.config.ts` proxies `/api/*` to `localhost:9191`
- **Production**: `bun run build` outputs to `web/dist/`, Bun serves static files + API, all on `9191`

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| Proxy internal error (config read fail, parse fail) | Return `502 Bad Gateway` + JSON error |
| Upstream unreachable (network error, timeout) | Return `502 Bad Gateway` + upstream error details |
| Upstream returns error (4xx/5xx) | Pass through upstream status code and response body as-is |
| Invalid config (rule references nonexistent upstream) | Fail at startup with validation error |

## 8. Logging

- `console.log` / `console.error` (Bun native)
- One line per request: `[timestamp] [model] [upstream] [status] duration`
- No log persistence, no over-engineering

## 9. Startup Flow (`server.ts`)

```
1. Read config.json (if missing, copy from config.example.json and prompt user)
2. Validate config (upstream IDs exist, rules reference valid upstreams, at least one default rule)
3. Start Bun.serve()
4. Request routing:
   - /api/* → config management API
   - /v1/* → proxy forwarding
   - Others → static files (production) or redirect to Vite dev server (development)
5. Print startup info: listening port, upstream count, rule count
```

## 10. Dependencies

**Package Manager**: Use **pnpm** for all dependency management. Do not use npm or yarn.

All dependencies must be installed at their **latest versions**. Code must be written against the latest API of each dependency. Before installation, verify latest version via `pnpm info <pkg> version` or context7 docs.

Installation commands:
- `pnpm add <package>` — add production dependency
- `pnpm add -D <package>` — add dev dependency
- `pnpm install` — install all dependencies from lockfile

Key dependencies:
- `bun-types` (dev)
- `react`, `react-dom`
- `vite`, `@vitejs/plugin-react`
- `typescript`
