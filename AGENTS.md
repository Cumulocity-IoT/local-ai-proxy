# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. Keep this file in
sync when the architecture or the load-bearing constraints below change.

## What this is

`local-ai-proxy` connects a **cloud Cumulocity AI agent** to a **local LM Studio**
(OpenAI-compatible) server on a Mac, without exposing the Mac. It ships as a
Cumulocity **microservice** (Nitro v3 + `c8y-nitro`, TypeScript) that holds a
persistent **reverse WebSocket tunnel** to a small Node client running on the Mac.

```
Agent (cloud) ──HTTP /v1/* (gateway auth)──▶ microservice ──WSS (outbound)──▶ mac-client ──▶ LM Studio
                                              (single replica, in-memory bridge)
```

See `README.md` for full setup/deploy. This file is the "how to change the code
safely" companion.

## Layout

- `nitro.config.ts` — Nitro + c8y-nitro config: `features.websocket`, manifest
  (roles, tenant-option settings, scale/isolation), `noExternals: ['tslib']`.
- `routes/agent-tunnel.ts` — WebSocket transport handler; **manual** tunnel-secret auth.
- `routes/v1/[...path].ts` — catch-all OpenAI surface; relays every `/v1/*` call
  over the tunnel, verbatim.
- `routes/health.get.ts`, `routes/provider-config.get.ts` — diagnostics.
- `lib/bridge.ts` — in-memory request↔response bridge (`currentPeer` + `pending` map).
- `lib/config.ts` — reads the tunnel secret (tenant option, env fallback in dev).
- `lib/provider-config.ts` — builds/logs the paste-ready Local provider JSON.
- `shared/protocol.ts` — WS frame types, shared by microservice **and** `mac-client`.
- `mac-client/` — Node/TS outbound tunnel client (its own package, shares `shared/`).

## Load-bearing constraints — do not break these

1. **Single replica only.** The bridge (`lib/bridge.ts`) is module-level in-memory
   state, so the agent's HTTP request and the Mac's WS **must** hit the same process.
   The manifest enforces this (`scale: NONE`, `isolation: PER_TENANT`). Never add
   auto-scale or move bridge state assuming shared memory across replicas.
2. **Non-streaming (v1).** `stream:true` is coerced to `false` in the catch-all
   route; responses come back as one JSON body. Streaming (SSE multiplexing over the
   tunnel) is a documented follow-up and needs an empirical gateway-buffering check
   first.
3. **WebSocket auth is manual.** `c8y-nitro`'s role-guard middleware only covers HTTP
   handlers, so the WS route checks the tunnel secret itself in the `open` hook
   (header `x-tunnel-secret` or `?secret=` query). Don't assume the guard runs there.
4. **Gateway auth on both surfaces.** Every `/service/local-ai-proxy/*` route —
   including the WS upgrade — requires a valid C8Y user. The mac-client therefore
   sends `C8Y_AUTH` on the upgrade in production; the agent sends
   `headers.Authorization` (Basic) which overrides the SDK's `Bearer <apiKey>`.
5. **15-minute request ceiling.** The mac-client proactively recycles its socket at
   ~10 min (`RECYCLE_MS`) and reconnects with backoff. Keep any long-lived-socket
   changes under that ceiling.

## API conventions (h3 v2 / Nitro 3)

This uses **h3 v2**, where the classic `event.*` request accessors are deprecated.
Use the modern forms — the deprecated ones still compile but should not be added:

| Deprecated (do not use) | Use instead |
|---|---|
| `event.method`, `getMethod(event)` | `event.req.method` |
| `readRawBody(event)` | `event.req.text()` / `event.req.arrayBuffer()` |
| `event.headers`, `getHeader(event, n)` | `event.req.headers.get(n)` |
| `event.path`, `getRequestPath(event)` | `event.url.pathname + event.url.search` |
| `event.node` | `event.runtime.{node|deno|...}` |
| `createError(...)`, `H3Error`, `isError(...)` | `new HTTPError(...)`, `HTTPError.isError(...)` |

`getRequestURL(event)`, `setResponseHeader`, `setResponseStatus`,
`event.context.params` are **not** deprecated; `event.url` is the idiomatic route to
the parsed URL.

## Tenant options / config

- Tunnel secret: tenant option **`tunnel.secret`** in category **`local.ai`**
  (see `settingsCategory` in `nitro.config.ts`). `lib/config.ts` treats `change-me`
  as unset and falls back to the `TUNNEL_SECRET` env var (dev only).
- `tunnel.secret` is **not** `credentials.`-prefixed, so Cumulocity stores it in
  plaintext. To store it encrypted, rename to `credentials.tunnelSecret` in both
  `nitro.config.ts` (`settings` + `cache`) and `lib/config.ts`.
- Optional `agentUser` + `credentials.agentPassword` (+ `publicBaseUrl`) only feed
  the auto-generated Local provider JSON (`lib/provider-config.ts`).
- If you add or rename a tenant-option key, update **all** of: `nitro.config.ts`
  `settings`/`cache`, the reader in `lib/`, `README.md`, and `.env.example`.

## Commands

```sh
pnpm install
pnpm dev            # local dev worker on :3000 (needs dummy C8Y_* env — see .env.example)
npx tsc --noEmit    # typecheck (there is no local `tsc` on PATH; use npx)
pnpm typegen        # nitro prepare — regenerate route types
pnpm build          # cross-builds a linux/amd64 image + deployable zip (Docker required)

# mac-client (separate package)
cd mac-client && node --import tsx --env-file=.env src/index.ts
```

## Gotchas

- **Build must be linux/amd64.** Cumulocity runs microservices on amd64; the `build`
  script pins `DOCKER_DEFAULT_PLATFORM=linux/amd64`. On Apple Silicon a default build
  produces arm64 and fails on the platform with `exec format error`.
- **`noExternals: ['tslib']`** is required: Nitro's tracer copies the wrong tslib
  export condition, causing `ERR_MODULE_NOT_FOUND …tslib/modules/index.js` at
  startup. If another dep hits the same error, add it to that list.
- **SSE content types are downgraded.** The catch-all rewrites `text/event-stream`
  responses to `text/plain` so c8y-nitro's response logging doesn't crash; the body
  is still forwarded verbatim. Revisit when adding real streaming.
- **`package.json` `author.name` is required** by c8y-nitro or the build fails.
- Don't import `@c8y/client` directly — use `c8y-nitro/utils` (`useTenantOption`,
  `useLogger`, `createLogger`). `@c8y/client` is only a transitive dependency.
