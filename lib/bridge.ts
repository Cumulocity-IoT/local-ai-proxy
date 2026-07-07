/**
 * In-memory bridge between inbound HTTP requests (from the cloud AI agent) and
 * the single Mac WebSocket peer that relays them to LM Studio.
 *
 * Correctness depends on this running in a SINGLE replica (see nitro.config.ts):
 * the agent's HTTP request and the Mac's WebSocket must be handled by the same
 * process, because `currentPeer` and `pending` are module-level state.
 */
import type { RequestFrame, ResponseFrame } from '../shared/protocol'

/** Minimal shape of a crossws peer (we only ever call `.send`). */
export interface TunnelPeer {
  send: (data: string) => unknown
}

interface Pending {
  resolve: (r: ResponseFrame) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let currentPeer: TunnelPeer | null = null
const pending = new Map<string, Pending>()
let counter = 0

export function hasPeer(): boolean {
  return currentPeer !== null
}

/** Register the Mac peer. Only one tunnel is supported; a new one replaces the old. */
export function registerPeer(peer: TunnelPeer): void {
  if (currentPeer && currentPeer !== peer) {
    // A second client connected — drop in-flight work tied to the old peer.
    failAllPending('tunnel replaced by a new client')
  }
  currentPeer = peer
}

/** Clear the peer (on close/error). If `peer` is given, only clear if it matches. */
export function clearPeer(peer?: TunnelPeer): void {
  if (peer && peer !== currentPeer) return
  currentPeer = null
  failAllPending('tunnel closed')
}

function failAllPending(message: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error(message))
    pending.delete(id)
  }
}

/** Resolve the pending request matching a response frame from the Mac. */
export function resolveResponse(frame: ResponseFrame): void {
  const p = pending.get(frame.id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(frame.id)
  p.resolve(frame)
}

/** Reject a pending request (the Mac reported an error reaching LM Studio). */
export function rejectResponse(id: string, message: string): void {
  const p = pending.get(id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(id)
  p.reject(new Error(message))
}

/**
 * Forward an HTTP request over the tunnel and await LM Studio's response.
 * Rejects immediately if no tunnel is connected, or after `timeoutMs`.
 */
export function sendRequest(
  req: Omit<RequestFrame, 'type' | 'id'>,
  timeoutMs = 120_000,
): Promise<ResponseFrame> {
  const peer = currentPeer
  if (!peer) return Promise.reject(new Error('tunnel offline'))

  const id = `req_${Date.now()}_${counter++}`
  const frame: RequestFrame = { type: 'request', id, ...req }

  return new Promise<ResponseFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('tunnel request timed out'))
    }, timeoutMs)

    pending.set(id, { resolve, reject, timer })

    try {
      peer.send(JSON.stringify(frame))
    }
    catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
