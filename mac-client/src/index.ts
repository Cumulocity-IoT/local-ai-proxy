/**
 * Mac-side tunnel client.
 *
 * Opens a persistent OUTBOUND WebSocket to the local-ai-proxy microservice and,
 * for each forwarded request it receives, replays it against the local LM Studio
 * server and streams the response back over the socket.
 *
 * Resilience:
 *  - protocol-level ping every HEARTBEAT_MS to keep the connection alive
 *  - proactive reconnect at RECYCLE_MS (< the platform's 15-min request ceiling)
 *  - exponential-backoff auto-reconnect on unexpected drops
 *
 * The Mac only ever makes outbound connections — LM Studio is never exposed.
 */
import WebSocket from 'ws'
import { TUNNEL_SECRET_HEADER } from '../../shared/protocol'
import type { ClientFrame, ErrorFrame, RequestFrame, ResponseFrame } from '../../shared/protocol'

const WSS_URL = process.env.PROXY_WSS_URL
const SECRET = process.env.TUNNEL_SECRET
const LMSTUDIO_URL = (process.env.LMSTUDIO_URL ?? 'http://127.0.0.1:1234').replace(/\/+$/, '')
// When the tunnel endpoint is behind the Cumulocity gateway (production), the WS
// upgrade must carry C8Y auth. Set C8Y_AUTH to a full header value, e.g. "Basic <b64>".
const C8Y_AUTH = process.env.C8Y_AUTH

if (!WSS_URL || !SECRET) {
  console.error('[client] PROXY_WSS_URL and TUNNEL_SECRET are required (see .env.example)')
  process.exit(1)
}

const RECYCLE_MS = 10 * 60_000 // reconnect before the ~15-min gateway request limit
const HEARTBEAT_MS = 30_000
const MAX_BACKOFF_MS = 30_000

let backoff = 1000

function connect(): void {
  const headers: Record<string, string> = { [TUNNEL_SECRET_HEADER]: SECRET! }
  if (C8Y_AUTH) headers.Authorization = C8Y_AUTH
  // Pass the secret as a query param too — some gateways drop custom headers on the
  // WS upgrade, and the query string is always forwarded with the path.
  const url = `${WSS_URL}${WSS_URL!.includes('?') ? '&' : '?'}secret=${encodeURIComponent(SECRET!)}`
  const ws = new WebSocket(url, { headers })
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let recycle: ReturnType<typeof setTimeout> | undefined
  let recycling = false

  ws.on('open', () => {
    console.log('[client] tunnel connected →', WSS_URL)
    backoff = 1000
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, HEARTBEAT_MS)
    recycle = setTimeout(() => {
      recycling = true
      console.log('[client] proactive reconnect (approaching gateway request limit)')
      connect() // open the replacement before closing the old socket
      ws.close(1000, 'recycle')
    }, RECYCLE_MS)
  })

  ws.on('message', (data) => {
    let frame: RequestFrame
    try {
      frame = JSON.parse(data.toString()) as RequestFrame
    }
    catch {
      return
    }
    if (frame.type === 'request') void handleRequest(ws, frame)
  })

  ws.on('close', (code, reason) => {
    if (heartbeat) clearInterval(heartbeat)
    if (recycle) clearTimeout(recycle)
    if (recycling) return // a replacement connection is already open
    console.log(`[client] tunnel closed (${code} ${reason.toString()}); reconnecting in ${backoff}ms`)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  })

  ws.on('error', (err) => {
    console.error('[client] socket error:', err.message)
  })
}

async function handleRequest(ws: WebSocket, frame: RequestFrame): Promise<void> {
  const send = (f: ClientFrame): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f))
  }
  try {
    const res = await fetch(`${LMSTUDIO_URL}${frame.path}`, {
      method: frame.method,
      headers: frame.headers,
      body: frame.body,
    })
    const body = await res.text()
    const response: ResponseFrame = {
      type: 'response',
      id: frame.id,
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      body,
    }
    send(response)
  }
  catch (err) {
    const error: ErrorFrame = {
      type: 'error',
      id: frame.id,
      message: err instanceof Error ? err.message : String(err),
    }
    send(error)
  }
}

console.log('[client] LM Studio target:', LMSTUDIO_URL)
connect()
