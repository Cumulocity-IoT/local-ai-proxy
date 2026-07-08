# local-ai-proxy

Connect a **cloud Cumulocity AI agent** to a **local LM Studio** (OpenAI-compatible)
server running on your Mac — without exposing your Mac to the internet and without a
VPN.

It ships as a Cumulocity **microservice** that holds a persistent **reverse
WebSocket tunnel** to a small client on your Mac. The agent's *Local provider*
`baseURL` points at the microservice; the microservice relays every OpenAI call over
the tunnel to `http://127.0.0.1:1234`. Your Mac only ever makes **outbound**
connections — LM Studio never accepts an inbound connection.

```
Agent (cloud) ──HTTP /v1/* (gateway auth: technical-user Basic)──▶ local-ai-proxy µservice
   POST /v1/responses, /v1/chat/completions,                       │  (single replica)
   GET /v1/models, …                                               │  in-memory bridge
                          ◀──────── response (verbatim JSON) ───────┤
                                                                    ▼
                          mac-client ◀── WSS (outbound, persistent) ┘
                          │              (transport only; keeps tunnel open)
                          ▼
                          LM Studio  http://127.0.0.1:1234/v1
```

**Why a reverse WebSocket tunnel and not a VPN?** Cumulocity microservices run with
`NET_ADMIN` dropped and no TUN device, so WireGuard/Tailscale-in-TUN are impossible;
and neither the Mac (behind NAT) nor the microservice (HTTPS-ingress only, no public
UDP port) is directly reachable, so raw WireGuard can't traverse it either. An
outbound WebSocket over the microservice's existing HTTPS ingress is the clean fit.

---

## Table of contents

1. [Repository layout](#repository-layout)
2. [Prerequisites](#prerequisites)
3. [Part A — Run it locally (no tenant)](#part-a--run-it-locally-no-tenant)
4. [Part B — Deploy to a Cumulocity tenant](#part-b--deploy-to-a-cumulocity-tenant)
5. [Configuration reference](#configuration-reference)
6. [How it works & operational notes](#how-it-works--operational-notes)
7. [Troubleshooting](#troubleshooting)

---

## Repository layout

```
nitro.config.ts        # Nitro + c8y-nitro config: websocket feature, manifest, tenant options
routes/
  agent-tunnel.ts      # WebSocket transport endpoint (manual tunnel-secret auth)
  v1/[...path].ts      # catch-all OpenAI surface → relayed over the tunnel
  health.get.ts        # GET /health → { status, tunnel }
  provider-config.get.ts # GET /provider-config → paste-ready Local provider JSON
lib/
  bridge.ts            # in-memory request↔response bridge (requires a single replica)
  config.ts            # tunnel secret (tenant option, env fallback in dev)
  provider-config.ts   # builds/logs the paste-ready Local provider JSON
shared/protocol.ts     # WebSocket frame types (shared with the mac-client)
mac-client/            # Node/TS client that runs on your Mac
  src/index.ts
  .env.example
.env.example           # microservice dev env template
AGENTS.md              # architecture + constraints for contributors / coding agents
```

---

## Prerequisites

- **Node 20+** and **pnpm** (`npm i -g pnpm`)
- **Docker** running (c8y-nitro builds the deployable image locally — deploy step only)
- **[LM Studio](https://lmstudio.ai)** with a model downloaded, loaded, and its server
  started: *Developer* tab → **Start Server** → it listens on `http://127.0.0.1:1234`
- A **Cumulocity tenant** where you can upload/subscribe microservices, plus admin
  credentials (deploy step only)
- Optional but recommended: **[go-c8y-cli](https://goc8ycli.netlify.app/)** (`c8y`)
  for scripting the tenant setup

---

## Part A — Run it locally (no tenant)

This runs the microservice on `localhost:3000` and the Mac client against it, so you
can validate the whole tunnel path before touching a tenant. LM Studio must be
running.

The c8y-nitro dev worker refuses to start without C8Y bootstrap env vars, so we give
it **dummy** ones — the tunnel secret is read from the `TUNNEL_SECRET` env var in dev
(see `lib/config.ts`, which falls back to env when the tenant option is absent).

**1. Start the microservice**

```sh
pnpm install
cp .env.example .env      # keep TUNNEL_SECRET; the dummy C8Y_* values are fine for local dev
pnpm dev                  # serves on http://localhost:3000
```

`.env` for local dev:

```env
TUNNEL_SECRET=dev-shared-secret-change-me
C8Y_BASEURL=http://localhost:9
C8Y_BOOTSTRAP_TENANT=t0
C8Y_BOOTSTRAP_USER=dummy
C8Y_BOOTSTRAP_PASSWORD=dummy
```

**2. Start the Mac client** (new terminal)

```sh
cd mac-client
pnpm install
cp .env.example .env       # PROXY_WSS_URL=ws://localhost:3000/agent-tunnel, matching TUNNEL_SECRET
node --import tsx --env-file=.env src/index.ts
```

You should see `tunnel connected → ws://localhost:3000/agent-tunnel`.

> Tip: run it via `node --import tsx …` (as above) rather than `pnpm start` — pnpm’s
> pre-run dependency check can abort before the script runs.

**3. Verify the path**

```sh
curl localhost:3000/health
# {"status":"ok","tunnel":"connected"}

curl localhost:3000/v1/models
# your LM Studio model list, relayed verbatim

curl localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"<a-loaded-model-id>","messages":[{"role":"user","content":"say hi"}],"max_tokens":20}'
# a real completion from your local model
```

Find a **loaded** model id via LM Studio’s native endpoint:

```sh
curl -s http://127.0.0.1:1234/api/v0/models | grep -E '"id"|"state"'
```

---

## Part B — Deploy to a Cumulocity tenant

Order matters: **upload → set tenant options → create the technical user → subscribe
(subscription starts the instance)**. Setting the tunnel secret before subscribing
means the microservice comes up already configured.

### B.1 — Bootstrap & build the deployable zip

```sh
npx c8y-nitro bootstrap    # prompts for dev creds, registers the app, writes real C8Y_* creds to .env
pnpm build                 # produces  ./local-ai-proxy-<version>.zip  (Dockerfile + image.tar + cumulocity.json)
```

`bootstrap` needs, in `.env`:

```env
C8Y_BASEURL=https://<your-tenant>.cumulocity.com
C8Y_DEVELOPMENT_TENANT=t<id>
C8Y_DEVELOPMENT_USER=<admin-user>
C8Y_DEVELOPMENT_PASSWORD=<admin-password>
```

> Docker must be running — `pnpm build` builds and exports the container image.

> **⚠️ Architecture (Apple Silicon / arm64 Macs).** Cumulocity runs microservices on
> **linux/amd64**. Docker on an arm64 Mac builds an arm64 image by default, which
> fails on the platform with `exec format error`. The `build` script therefore sets
> **`DOCKER_DEFAULT_PLATFORM=linux/amd64`** so the image is cross-built for amd64.
> The generated Dockerfile only does `FROM node:24-slim` + `COPY .output/` (no
> compile step) and Nitro’s output is pure JS, so the cross-build needs no QEMU
> emulation and is fast. Verify with:
> ```sh
> docker image inspect c8y-app:latest --format 'Arch={{.Architecture}} OS={{.Os}}'
> # → Arch=amd64 OS=linux
> ```
> (If Cumulocity ever runs your microservices on arm64, drop the env var from the
> `build` script or set it to `linux/arm64`.)

### B.2 — Upload the microservice (creates the application, does **not** start it yet)

**Administration UI:** *Ecosystem → Microservices → Add microservice →* upload
`local-ai-proxy-<version>.zip`. Leave it **unsubscribed** for now.

**or go-c8y-cli:**

```sh
c8y microservices create --file ./local-ai-proxy-<version>.zip --skipSubscription
```

### B.3 — Configure tenant options **before** subscribing

The microservice reads its tunnel secret from the tenant option **`tunnel.secret`**
in category **`local.ai`** (the manifest ships a placeholder default `change-me`,
which the service treats as *unset* and refuses — so you must set a real value).

> Keys prefixed `credentials.` are stored **encrypted** by Cumulocity; `tunnel.secret`
> is not, so it is stored in plaintext. If you'd rather keep the secret encrypted,
> rename it to `credentials.tunnelSecret` in `nitro.config.ts` (`settings` + `cache`)
> and in `lib/config.ts`, and use that key below.

Generate a strong secret:

```sh
openssl rand -hex 32        # e.g. 7f3a…  — use the same value in mac-client/.env
```

Set it on the tenant (values under keys prefixed `credentials.` are stored
**encrypted** by Cumulocity):

**go-c8y-cli:**

```sh
c8y tenantoptions create \
  --category local.ai \
  --key "tunnel.secret" \
  --value "<your-generated-secret>"
```

**or REST (admin basic auth):**

```sh
curl -u "<admin-user>:<admin-password>" \
  -X POST "https://<tenant>.cumulocity.com/tenant/options" \
  -H "Content-Type: application/json" \
  -d '{"category":"local.ai","key":"tunnel.secret","value":"<your-generated-secret>"}'
```

| Tenant option | Category | Value | Notes |
|---|---|---|---|
| `tunnel.secret` | `local.ai` | strong random string | **Required.** Must match `mac-client/.env` `TUNNEL_SECRET`. |
| `agentUser` | `local.ai` | `svc-local-ai-proxy` | *Optional.* Technical user (B.4). Only used to auto-fill the Local provider JSON. |
| `credentials.agentPassword` | `local.ai` | that user's password | *Optional.* Encrypted. With `agentUser`, fills in the `Authorization` header for you. |
| `publicBaseUrl` | `local.ai` | `https://<tenant>.cumulocity.com` | *Optional.* Override if the runtime `C8Y_BASEURL` isn't the public domain. |

> Setting the two optional `agent*` options is worth it: the microservice will then
> print — and serve at `GET /provider-config` — a **fully-formed, copy-paste-ready**
> Local provider JSON (see B.7), Authorization header included.

### B.4 — Create the dedicated technical user

The agent authenticates to the microservice as a C8Y user whose **only** access is
this microservice.

1. **Global role (user group):** *Administration → Roles → Global roles → Add* a
   role like `local-ai-proxy-caller`. Under **Applications**, grant access to the
   `local-ai-proxy` microservice only — no other applications or permissions.
2. **User:** *Administration → Accounts → Users → Add user* `svc-local-ai-proxy`
   with a strong password; assign it the `local-ai-proxy-caller` global role only.

Keep the `svc-local-ai-proxy` username + password — they go into the agent config
(B.7) as base64 Basic auth.

### B.5 — Subscribe the microservice (this starts it)

**Administration UI:** open the `local-ai-proxy` microservice → **Subscribe**.

**or go-c8y-cli:**

```sh
c8y microservices enable --id local-ai-proxy
```

On subscription Cumulocity starts a single instance (the manifest sets
`isolation: PER_TENANT`, `scale: NONE`) and grants the service user its
`requiredRoles` (`ROLE_OPTION_MANAGEMENT_READ`, so it can read the tunnel secret).

Check it: `GET https://<tenant>.cumulocity.com/service/local-ai-proxy/health` (with a
valid user) should return `{"status":"ok","tunnel":"offline"}` until the Mac connects.

### B.6 — Run the Mac client against the deployed endpoint

In `mac-client/.env`:

```env
PROXY_WSS_URL=wss://<tenant>.cumulocity.com/service/local-ai-proxy/agent-tunnel
TUNNEL_SECRET=<the-same-secret-from-B.3>
LMSTUDIO_URL=http://127.0.0.1:1234
# The WS upgrade goes through the Cumulocity gateway, which requires C8Y auth.
# Use the technical user from B.4 (or any user with access to the microservice):
#   printf '<user>:<password>' | base64
C8Y_AUTH=Basic <base64 of user:password>
```

> **`C8Y_AUTH` is required in production** (not for local dev). The gateway rejects
> the WebSocket upgrade with `401`/`404` without it. Local dev (`ws://localhost:3000`)
> has no gateway, so leave it unset there.

```sh
cd mac-client
node --import tsx --env-file=.env src/index.ts
```

`/health` should now report `"tunnel":"connected"`.

### B.7 — Configure the agent’s Local provider

**The microservice hands you the JSON.** As soon as the Mac client connects, it
logs a ready-to-paste block (baseURL and — if the optional `agent*` tenant options
from B.3 are set — the `Authorization` header, filled in), and the model is
auto-detected from LM Studio:

```
=== Local provider JSON — paste into the agent's "Local provider" field ===
{
  "name": "openai",
  "baseURL": "https://<tenant>.cumulocity.com/service/local-ai-proxy/v1",
  "apiKey": "unused-dummy",
  "model": "google/gemma-4-26b-a4b-qat",
  "headers": { "Authorization": "Basic <…>" }
}
===========================================================================
```

You can also fetch it any time (gateway-protected):

```sh
curl -u '<user>:<password>' https://<tenant>.cumulocity.com/service/local-ai-proxy/provider-config
```

Copy the JSON into the AI Agent manager → your agent → **Local provider**. Notes:
`name:"openai"`; **no `compatibility`** (invalid for the OpenAI provider); `apiKey`
is a required-but-unused dummy; the C8Y Basic auth in `headers` overrides the SDK’s
Bearer. If you didn’t set the `agent*` options, fill the header yourself:
`printf 'svc-local-ai-proxy:<password>' | base64`.

Run a prompt from the agent’s **Test** tab — it should be answered by your local
model (watch LM Studio’s log to confirm).

---

## Configuration reference

**Microservice `.env`** (dev only — production uses tenant options + bootstrap creds):

| Var | Purpose |
|---|---|
| `TUNNEL_SECRET` | Dev fallback for the tunnel secret when the tenant option is absent |
| `C8Y_BASEURL`, `C8Y_BOOTSTRAP_*` | Required for the dev worker to start (dummy values OK locally) |
| `C8Y_DEVELOPMENT_*` | Needed by `c8y-nitro bootstrap` to register the app |

**`mac-client/.env`:**

| Var | Purpose | Default |
|---|---|---|
| `PROXY_WSS_URL` | WS URL of the tunnel endpoint (`…/service/local-ai-proxy/agent-tunnel`) | — |
| `TUNNEL_SECRET` | Must match the microservice’s secret | — |
| `LMSTUDIO_URL` | Local LM Studio base URL | `http://127.0.0.1:1234` |
| `C8Y_AUTH` | Full auth header for the gateway WS upgrade, e.g. `Basic <b64>`. **Required in production**, unset for local dev. | — |

**Tenant options** (category `local.ai`):

| Key | Required | Notes |
|---|---|---|
| `tunnel.secret` | ✅ | Must match `mac-client` `TUNNEL_SECRET` (plaintext — see B.3 for an encrypted alternative) |
| `agentUser` | – | Technical user name; only used to auto-fill the Local provider JSON |
| `credentials.agentPassword` | – | Encrypted; with `agentUser`, fills the `Authorization` header |
| `publicBaseUrl` | – | Override the public base URL if runtime `C8Y_BASEURL` isn’t the public domain |

---

## How it works & operational notes

- **Single replica is mandatory.** The request↔response bridge is in-memory, so the
  agent’s HTTP request and the Mac’s WebSocket must be handled by the same process.
  The manifest sets `scale: NONE`, `isolation: PER_TENANT`. **Do not enable
  auto-scale** — a second replica would not hold the tunnel and would return `503`.
- **15-minute request ceiling.** Cumulocity may terminate long requests. The Mac
  client sends heartbeats, proactively recycles its socket at ~10 min, and
  auto-reconnects with backoff — so idle periods and the ceiling are transparent.
- **Streaming and buffered, chosen per request.** Requests with `stream:true` are
  relayed token-by-token: the Mac forwards LM Studio’s SSE as `response-start` /
  `response-chunk` / `response-end` frames, and the proxy re-emits them as a chunked
  HTTP response. Requests without streaming are buffered into one JSON body.
  - The streamed response is labeled **`text/plain`** (not `text/event-stream`): the
    logging layer bundled by c8y-nitro (evlog) crashes on a streamed `text/event-stream`
    response under h3 v2, and `text/plain` avoids that while still streaming the SSE
    body verbatim. AI SDK clients parse the body as SSE regardless of this label.
  - One caveat to verify on a real tenant: the C8Y gateway *may* buffer the SSE body
    before forwarding — if so, streaming is still functionally correct (the agent
    receives the full stream), just not incremental.
- **Which endpoint does the agent call?** The Vercel AI SDK’s default `openai(model)`
  may target the **Responses API** (`POST /v1/responses`) rather than
  `/v1/chat/completions`. The proxy forwards whatever path arrives, so make sure your
  LM Studio version implements the endpoint your agent uses.
- **Auth model.** All microservice routes are gateway-protected; there are no
  anonymous endpoints. The `agent-tunnel` WebSocket is additionally guarded by the
  shared tunnel secret (checked manually in the `open` hook, since c8y-nitro’s
  role-guard middleware only applies to HTTP handlers).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 {"error":{"type":"tunnel_offline"}}` | The Mac client isn’t connected. Start it; check `PROXY_WSS_URL` and network. |
| Mac client can't open the WS at all (`401`/`404` on upgrade, in production) | `C8Y_AUTH` is unset or wrong. The gateway needs valid C8Y Basic auth on the WS upgrade — set `C8Y_AUTH=Basic <base64 user:password>` in `mac-client/.env` (B.6). |
| Mac client connects then immediately closes (`1008 unauthorized`) | `TUNNEL_SECRET` mismatch, or the tenant option `tunnel.secret` (category `local.ai`) is unset/`change-me`. |
| Agent calls fail with 401/403 at the gateway | Technical user lacks access to the `local-ai-proxy` application, or the `headers.Authorization` base64 is wrong. |
| `Failed to load model …insufficient system resources` | LM Studio couldn’t load that model — use a model that’s already **loaded** (see the `/api/v0/models` check). |
| Agent gets 404 from `/v1/responses` | Your LM Studio doesn’t implement the Responses API endpoint the SDK uses — update LM Studio, or (follow-up) add a `/responses`→`/chat/completions` shim. |
| `pnpm build` fails | Ensure Docker is running and in `PATH`. |
| Microservice won’t start on the tenant / `exec format error` in logs | Image built for the wrong architecture. The `build` script sets `DOCKER_DEFAULT_PLATFORM=linux/amd64`; confirm your image is `amd64` (see the build note in B.1). |
| `ERR_MODULE_NOT_FOUND … tslib/modules/index.js` at startup | Nitro’s tracer copied the wrong `tslib` export condition. Fixed by `noExternals: ['tslib']` in `nitro.config.ts`, which bundles tslib in. If another dependency shows the same error, add it to that list and rebuild. |
