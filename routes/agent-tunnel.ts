/**
 * WebSocket route: /agent-tunnel
 *
 * The Mac client opens a persistent outbound WSS connection here. This socket is
 * pure transport — it keeps the reverse tunnel open so the microservice can push
 * forwarded HTTP requests to the Mac and receive responses back.
 *
 * Auth is enforced manually in `open` (c8y-nitro's role-guard middleware only
 * applies to HTTP handlers, not WebSocket handlers): the client must present the
 * shared tunnel secret via the `x-tunnel-secret` header or a `?secret=` query param.
 */
import { defineWebSocketHandler } from 'nitro/h3'
import { createLogger } from 'c8y-nitro/utils'
import { clearPeer, registerPeer, rejectResponse, resolveResponse, type TunnelPeer } from '../lib/bridge'
import { useTunnelSecret } from '../lib/config'
import { logLocalProviderConfigOnce } from '../lib/provider-config'
import { TUNNEL_SECRET_HEADER, type ClientFrame } from '../shared/protocol'

function extractSecret(peer: { request?: { headers?: Headers, url?: string } }): string | null {
  const req = peer.request
  if (!req)
    return null
  const fromHeader = req.headers?.get?.(TUNNEL_SECRET_HEADER)
  if (fromHeader)
    return fromHeader
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams.get('secret')
  }
  catch {
    return null
  }
}

export default defineWebSocketHandler({
  async open(peer) {
    const expected = await useTunnelSecret()
    const provided = extractSecret(peer)
    if (!expected || provided !== expected) {
      const log = createLogger({ channel: 'tunnel', action: 'websocket.open' })
      log.set({
        message: 'Unauthorized websocket connect; closing with 1008',
        reason: expected ? 'tunnel secret mismatch' : 'tunnel secret not set in microservice',
      })
      log.emit()
      peer.close(1008, 'unauthorized')
      return
    }
    registerPeer(peer as unknown as TunnelPeer)
    const log = createLogger({ channel: 'tunnel', action: 'websocket.open' })
    log.set({ message: 'Mac client connected' })
    log.emit()
    // Print the paste-ready Local provider JSON now that the tunnel (and thus the
    // model list) is available. Fire-and-forget; never blocks the connection.
    void logLocalProviderConfigOnce()
  },

  message(peer, message) {
    let frame: ClientFrame
    try {
      frame = JSON.parse(message.text()) as ClientFrame
    }
    catch {
      return
    }
    switch (frame.type) {
      case 'response':
        resolveResponse(frame)
        break
      case 'error':
        rejectResponse(frame.id, frame.message)
        break
      case 'ping':
        peer.send(JSON.stringify({ type: 'pong' }))
        break
      case 'pong':
        break
    }
  },

  close(peer) {
    clearPeer(peer as unknown as TunnelPeer)
    const log = createLogger({ channel: 'tunnel', action: 'websocket.close' })
    log.set({ message: 'Mac client disconnected' })
    log.emit()
  },

  error(peer) {
    clearPeer(peer as unknown as TunnelPeer)
  },
})
