# 3router

Local Claude Code API proxy with intelligent routing — route requests to different upstreams/models based on message content.

## Quick Start

```bash
pnpm install
cp config.example.json config.json
# Edit config.json with your API keys
bun run dev
```

Set `ANTHROPIC_BASE_URL=http://localhost:9191` in your Claude Code config.

## Development

```bash
# Terminal 1: Backend
bun run dev

# Terminal 2: Frontend
cd web && pnpm dev
```

Frontend: http://localhost:5173 (proxies /api to backend)

## Production

```bash
pnpm build
pnpm start
```

Everything served on http://localhost:9191.

## Routing Rules

- **has_image**: Messages containing image content blocks
- **default**: All other messages (pure text, assistant messages)

Rules are matched by priority (lower number = higher priority).

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start backend with file watching |
| `pnpm build` | Build frontend for production |
| `pnpm start` | Start production server |
| `pnpm test` | Run all tests |
| `pnpm lint` | Run oxlint |
| `pnpm format` | Format code with oxfmt |
