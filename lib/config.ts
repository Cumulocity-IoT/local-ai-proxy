/**
 * Runtime configuration helpers.
 *
 * The tunnel secret lives in the tenant option "tunnel.secret" in production.
 * During `pnpm dev` there is usually no
 * bootstrapped tenant option yet, so we fall back to the TUNNEL_SECRET env var.
 */
import { useTenantOption } from 'c8y-nitro/utils'

export async function useTunnelSecret(): Promise<string> {
  try {
    const value = await useTenantOption('tunnel.secret')
    if (value && value !== 'change-me') return value
  }
  catch {
    // Not bootstrapped (e.g. local dev) — fall through to env.
  }
  return process.env.TUNNEL_SECRET ?? ''
}
