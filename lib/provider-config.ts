/**
 * Builds the ready-to-paste "Local provider" JSON for the AI Agent form.
 *
 * The microservice knows its own public base URL (from the tenant option
 * `publicBaseUrl`, else the runtime C8Y_BASEURL) and — once the tunnel is up — the
 * model ids reported by LM Studio. If the optional technical-user credentials are
 * configured as tenant options, the Authorization header is filled in too;
 * otherwise a clearly-marked placeholder is emitted.
 */
import { createLogger, useTenantOption } from 'c8y-nitro/utils'
import { sendRequest } from './bridge'

const CONTEXT_PATH = 'local-ai-proxy'
const AUTH_PLACEHOLDER = 'Basic <base64 of svc-local-ai-proxy:password>'

async function tryTenantOption(key: string): Promise<string | undefined> {
  try {
    const value = await useTenantOption(key as never)
    if (value && value !== 'change-me') return value
  }
  catch {
    // not set / dev — ignore
  }
  return undefined
}

async function resolveBaseUrl(): Promise<string> {
  const override = await tryTenantOption('publicBaseUrl')
  const base = (override ?? process.env.C8Y_BASEURL ?? 'https://<tenant>.cumulocity.com').replace(/\/+$/, '')
  return `${base}/service/${CONTEXT_PATH}/v1`
}

async function resolveAuthHeader(): Promise<{ header: string, resolved: boolean }> {
  const user = await tryTenantOption('agentUser')
  const pass = await tryTenantOption('credentials.agentPassword')
  if (user && pass) {
    return { header: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, resolved: true }
  }
  return { header: AUTH_PLACEHOLDER, resolved: false }
}

/** Ask LM Studio (over the tunnel) for a model id to suggest. Falls back to a placeholder. */
async function suggestModel(): Promise<string> {
  try {
    const resp = await sendRequest({ method: 'GET', path: '/v1/models', headers: {} }, 10_000)
    const parsed = JSON.parse(resp.body) as { data?: Array<{ id?: string }> }
    const first = parsed?.data?.[0]?.id
    if (typeof first === 'string' && first) return first
  }
  catch {
    // tunnel not ready / LM Studio unreachable — use a placeholder
  }
  return '<lm-studio-model-id>'
}

export interface ProviderConfigResult {
  config: {
    name: 'openai'
    baseURL: string
    apiKey: string
    model: string
    headers: Record<string, string>
  }
  /** True when agentUser + credentials.agentPassword tenant options are set. */
  authResolved: boolean
}

export async function buildLocalProviderConfig(): Promise<ProviderConfigResult> {
  const [baseURL, auth, model] = await Promise.all([resolveBaseUrl(), resolveAuthHeader(), suggestModel()])
  return {
    config: {
      name: 'openai',
      baseURL,
      apiKey: 'unused-dummy',
      model,
      headers: { Authorization: auth.header },
    },
    authResolved: auth.resolved,
  }
}

let loggedOnce = false

/** Log the paste-ready JSON once per process (on the first tunnel connect). */
export async function logLocalProviderConfigOnce(): Promise<void> {
  if (loggedOnce) return
  loggedOnce = true
  const { config, authResolved } = await buildLocalProviderConfig()
  const log = createLogger({ channel: 'provider-config', action: 'emit-local-provider-config' })
  log.set({
    message: 'Local provider config ready to paste into AI Agent Local provider field',
    authResolved,
    config,
    hint: authResolved
      ? undefined
      : 'Authorization is a placeholder. Set tenant options agentUser and credentials.agentPassword to fill it automatically.',
  })
  log.emit()
}
