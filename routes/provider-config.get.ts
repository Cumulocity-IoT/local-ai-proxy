/**
 * GET /provider-config
 *
 * Returns the ready-to-paste "Local provider" JSON for the AI Agent form, with the
 * baseURL (and, if the technical-user tenant options are set, the Authorization
 * header) filled in. Handy to `curl` after subscribing instead of hand-building it.
 *
 * Gateway-protected like every other route.
 */
import { defineEventHandler } from 'nitro/h3'
import { buildLocalProviderConfig } from '../lib/provider-config'

export default defineEventHandler(async () => {
  const { config, authResolved } = await buildLocalProviderConfig()
  return {
    localProvider: config,
    authResolved,
    hint: authResolved
      ? 'Paste `localProvider` into the agent\'s Local provider field.'
      : 'Set tenant options `agentUser` and `credentials.agentPassword` to fill in the Authorization header automatically, or replace the placeholder yourself.',
  }
})
