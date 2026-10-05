# TXT CLAW Stack (public mirror)

The runtime behind [TXT CLAW](https://github.com/woodbeary/rotary): a Cloudflare Worker and per-user Sandbox containers that give every user an always-on OpenClaw agent, plus a developer-facing HTTP and MCP surface. February 2026.

Stack: TypeScript, Hono, React, Cloudflare Workers, Cloudflare Sandbox, Durable Objects, R2

**Built on:** Cloudflare's open-source [moltworker](https://github.com/cloudflare/moltworker), which provides the base Worker, Sandbox, R2 wiring, and admin UI, and [OpenClaw](https://github.com/openclaw/openclaw), the agent itself.

**What I added:** one sandboxed agent per user, keyed through a Durable Objects directory; the SMS and iMessage channels; the public developer API with console keys, bring-your-own-key, rate limits, and traces; warm-sandbox keepalive; hardened R2 persistence; and the docs in this repo.

For the product story, screenshots, and architecture, see the [TXT CLAW → Rotary showcase](https://github.com/woodbeary/rotary).

## What This Repo Shows

- Worker-based gateway wrapper around an agent runtime
- Authenticated admin UI with device approval flow
- Durable Object backed directory and traces
- Optional persistent storage via R2
- Public API routes plus companion docs for HTTP and MCP usage

## Quickstart

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

For local development:

```bash
pnpm start
```

## Public Docs Included

- [`docs/quickstart.md`](./docs/quickstart.md)
- [`docs/agents.md`](./docs/agents.md)
- [`docs/openapi.yaml`](./docs/openapi.yaml)
- [`docs/mcp.md`](./docs/mcp.md)
- [`docs/routing.md`](./docs/routing.md)
- [`docs/byok.md`](./docs/byok.md)

## Repo Highlights

- [`src/routes`](./src/routes): public routes, admin routes, and API entrypoints
- [`src/txtclaw`](./src/txtclaw): runtime, credentials, limits, traces, and bridge logic
- [`src/client`](./src/client): admin/control UI

## Why This Matters

This is the productization side of AI systems work: taking a powerful but messy runtime, then wrapping it in a control plane that developers and operators can actually use. The interesting part is not just running the model loop. It is auth, persistence, lifecycle, traceability, failure recovery, and a clean external surface.

## Security / Public Mirror Notes

- Private deployment state, generated build output, local env files, and launch/partnership docs were removed
- This mirror keeps the core runtime/control-plane code and a cleaned documentation surface
- Some provider env var names remain in source because they are part of the integration contract, but no live secrets or private domains are included
