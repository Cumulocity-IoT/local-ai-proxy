/**
 * GET /health
 *
 * Human/diagnostic health endpoint reporting whether the Mac tunnel is connected.
 * (Kubernetes liveness/readiness probes use c8y-nitro's built-in
 * /_c8y_nitro/liveness and /_c8y_nitro/readiness endpoints instead.)
 */
import { defineEventHandler } from 'nitro/h3'
import { hasPeer } from '../lib/bridge'

export default defineEventHandler(() => ({
  status: 'ok',
  tunnel: hasPeer() ? 'connected' : 'offline',
}))
