/**
 * In-memory bridge between inbound HTTP requests (from the cloud AI agent) and
 * the single Mac WebSocket peer that relays them to LM Studio.
 *
 * Correctness depends on this running in a SINGLE replica (see nitro.config.ts):
 * the agent's HTTP request and the Mac's WebSocket must be handled by the same
 * process, because `currentPeer` and `pending` are module-level state.
 *
 * Two response shapes are supported, both correlated by request `id`:
 *  - Buffered: `sendRequest()` resolves once on the matching ResponseFrame.
 *  - Streaming: `sendRequestStreaming()` resolves on ResponseStartFrame with a
 *    ReadableStream that is fed by ResponseChunkFrames and closed by ResponseEndFrame.
 */
import type { RequestFrame, ResponseFrame } from '../shared/protocol'

/** Minimal shape of a crossws peer (we only ever call `.send`). */
export interface TunnelPeer {
  send: (data: string) => unknown
}

/** A buffered request awaiting a single ResponseFrame. */
interface BufferedPending {
  kind: 'buffered'
  resolve: (r: ResponseFrame) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** A streaming request: before start we hold the start resolver; after start the controller. */
interface StreamingPending {
  kind: 'streaming'
  /** Resolves once ResponseStartFrame arrives. */
  resolveStart: (r: StreamHandle) => void
  rejectStart: (e: Error) => void
  /** Set once the stream has started; feeds ResponseChunk/End frames. */
  controller: ReadableStreamDefaultController<Uint8Array> | null
  started: boolean
  /** First-byte timeout (pre-start) or inactivity timeout (post-start). */
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number
  encoder: TextEncoder
}

type Pending = BufferedPending | StreamingPending

/** What `sendRequestStreaming` resolves to once the response has started. */
export interface StreamHandle {
  status: number
  headers: Record<string, string>
  stream: ReadableStream<Uint8Array>
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

/**
 * Tell the Mac to abort the upstream LM Studio request for `id`. Called whenever
 * we stop caring about a response (timeout, downstream client disconnect) so the
 * model stops generating and the tunnel stops carrying chunks nobody reads.
 */
function notifyCancel(id: string): void {
  const peer = currentPeer
  if (!peer) return
  try {
    peer.send(JSON.stringify({ type: 'cancel', id }))
  }
  catch {
    // Peer is going away — nothing to cancel against.
  }
}

function failAllPending(message: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    failPending(p, new Error(message))
    pending.delete(id)
  }
}

/** Reject/error a pending entry regardless of kind. Does not touch the map or timer. */
function failPending(p: Pending, err: Error): void {
  if (p.kind === 'buffered') {
    p.reject(err)
    return
  }
  if (p.started && p.controller) {
    try {
      p.controller.error(err)
    }
    catch {
      // Controller already closed/errored — ignore.
    }
  }
  else {
    p.rejectStart(err)
  }
}

/** Resolve a buffered request matching a ResponseFrame from the Mac. */
export function resolveResponse(frame: ResponseFrame): void {
  const p = pending.get(frame.id)
  if (!p || p.kind !== 'buffered') return
  clearTimeout(p.timer)
  pending.delete(frame.id)
  p.resolve(frame)
}

/** Begin a streamed response: resolve the start handle with a fresh ReadableStream. */
export function startStream(id: string, status: number, headers: Record<string, string>): void {
  const p = pending.get(id)
  if (!p || p.kind !== 'streaming' || p.started) return
  clearTimeout(p.timer)
  p.started = true

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      p.controller = controller
    },
    cancel() {
      // Downstream (the HTTP client) went away — drop the pending entry and
      // abort the upstream request on the Mac.
      clearTimeout(p.timer)
      pending.delete(id)
      notifyCancel(id)
    },
  })

  // Post-start: reset an inactivity timer on each chunk so a stalled upstream is cut.
  p.timer = setTimeout(() => {
    pending.delete(id)
    notifyCancel(id)
    if (p.controller) {
      try {
        p.controller.error(new Error('tunnel stream timed out (no chunks)'))
      }
      catch {
        // ignore
      }
    }
  }, p.timeoutMs)

  p.resolveStart({ status, headers, stream })
}

/** Append a chunk to an in-progress streamed response. */
export function pushChunk(id: string, data: string): void {
  const p = pending.get(id)
  if (!p || p.kind !== 'streaming' || !p.controller) return
  clearTimeout(p.timer)
  p.timer = setTimeout(() => {
    pending.delete(id)
    notifyCancel(id)
    try {
      p.controller?.error(new Error('tunnel stream timed out (no chunks)'))
    }
    catch {
      // ignore
    }
  }, p.timeoutMs)
  try {
    p.controller.enqueue(p.encoder.encode(data))
  }
  catch {
    // Controller closed (client disconnected) — stop tracking and abort upstream.
    clearTimeout(p.timer)
    pending.delete(id)
    notifyCancel(id)
  }
}

/** Close an in-progress streamed response normally. */
export function endStream(id: string): void {
  const p = pending.get(id)
  if (!p || p.kind !== 'streaming') return
  clearTimeout(p.timer)
  pending.delete(id)
  if (p.controller) {
    try {
      p.controller.close()
    }
    catch {
      // ignore
    }
  }
}

/** Reject/error a pending request (the Mac reported an error reaching LM Studio). */
export function rejectResponse(id: string, message: string): void {
  const p = pending.get(id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(id)
  failPending(p, new Error(message))
}

function nextId(): string {
  return `req_${Date.now()}_${counter++}`
}

/**
 * Forward an HTTP request over the tunnel and await LM Studio's buffered response.
 * Rejects immediately if no tunnel is connected, or after `timeoutMs`.
 */
export function sendRequest(
  req: Omit<RequestFrame, 'type' | 'id' | 'stream'>,
  timeoutMs = 120_000,
): Promise<ResponseFrame> {
  const peer = currentPeer
  if (!peer) return Promise.reject(new Error('tunnel offline'))

  const id = nextId()
  const frame: RequestFrame = { type: 'request', id, ...req }

  return new Promise<ResponseFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      notifyCancel(id)
      reject(new Error('tunnel request timed out'))
    }, timeoutMs)

    pending.set(id, { kind: 'buffered', resolve, reject, timer })

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

/**
 * Forward an HTTP request over the tunnel and stream LM Studio's response back.
 * Resolves once the response has started (ResponseStartFrame) with the upstream
 * status/headers and a ReadableStream carrying the body. Rejects if no tunnel is
 * connected, on a pre-start error, or if the first frame does not arrive within
 * `firstByteMs`. After start, a per-chunk inactivity timeout (`idleMs`) applies.
 */
export function sendRequestStreaming(
  req: Omit<RequestFrame, 'type' | 'id' | 'stream'>,
  firstByteMs = 120_000,
  idleMs = 120_000,
): Promise<StreamHandle> {
  const peer = currentPeer
  if (!peer) return Promise.reject(new Error('tunnel offline'))

  const id = nextId()
  const frame: RequestFrame = { type: 'request', id, stream: true, ...req }

  return new Promise<StreamHandle>((resolveStart, rejectStart) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      notifyCancel(id)
      rejectStart(new Error('tunnel request timed out'))
    }, firstByteMs)

    pending.set(id, {
      kind: 'streaming',
      resolveStart,
      rejectStart,
      controller: null,
      started: false,
      timer,
      timeoutMs: idleMs,
      encoder: new TextEncoder(),
    })

    try {
      peer.send(JSON.stringify(frame))
    }
    catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      rejectStart(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
