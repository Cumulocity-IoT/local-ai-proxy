import { defineNitroConfig } from 'nitro/config'
import c8y from 'c8y-nitro'

export default defineNitroConfig({
  preset: 'node_server',
  // routes/, lib/, shared/ live at the project root (same layout as the starter).
  serverDir: './',

  builder: 'rolldown',

  // Enables WebSocket support (crossws). The WebSocket is the *transport* that
  // keeps the reverse-proxy tunnel to the Mac open — it carries no OpenAI logic.
  features: {
    websocket: true,
  },

  experimental: {
    // async_hooks-based context propagation so useLogger() works from nested calls.
    asyncContext: true,
  },

  // Bundle tslib into the server output instead of externalizing it. The dependency
  // tracer copies tslib's `default` export condition (tslib.es6.mjs) but Node at
  // runtime resolves the `node` condition (tslib/modules/index.js), which isn't
  // copied → ERR_MODULE_NOT_FOUND. Inlining sidesteps the runtime resolution.
  noExternals: ['tslib'],

  c8y: {
    manifest: {
      settingsCategory: 'local.ai',
      // The single role the dedicated technical user is granted so it may call
      // this microservice (and nothing else) via the C8Y gateway.
      roles: ['ROLE_LOCAL_AI_PROXY_ACCESS'],
      // Tenant options read at runtime. "credentials." keys are stored encrypted.
      settings: [
        // Required: shared secret the Mac client must present on the WS tunnel.
        { key: 'tunnel.secret', defaultValue: 'change-me' },
        // Optional: used only to auto-fill the Local provider JSON (see /provider-config).
        // The technical user the agent authenticates as.
        { key: 'agentUser', defaultValue: 'change-me' },
        { key: 'credentials.agentPassword', defaultValue: 'change-me' },
        // Optional: override the public tenant base URL if the runtime C8Y_BASEURL
        // is not the externally reachable domain.
        { key: 'publicBaseUrl', defaultValue: 'change-me' },
      ],
      // The service user needs to read tenant options (to fetch the tunnel secret).
      requiredRoles: ['ROLE_OPTION_MANAGEMENT_READ'],

      // ── Deploy-time runtime shape ──────────────────────────────────────────
      // The reverse-tunnel bridge is in-memory, so the agent's HTTP request and
      // the Mac's WebSocket MUST land in the same process → force a SINGLE replica
      // (no auto-scale). PER_TENANT gives this tenant its own instance.
      // NOTE: these keys map to the Cumulocity microservice manifest spec; verify
      // c8y-nitro passes them through as-is before the first real deploy (Phase 3).
      isolation: 'PER_TENANT',
      scale: 'NONE',
    },

    cache: {
      credentialsTTL: 600,
      tenantOptions: {
        'tunnel.secret': 300,
      },
    },
  },

  modules: [
    c8y(),
  ],
})
