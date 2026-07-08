/**
 * Catch-all OpenAI-compatible surface: /v1/*
 *
 * This is the URL the cloud agent's `baseURL` points at. Every call — GET /v1/models,
 * POST /v1/responses, POST /v1/chat/completions, POST /v1/completions,
 * POST /v1/embeddings, … — is relayed transparently over the tunnel to LM Studio;
 * there is no per-endpoint logic here.
 *
 * The route is gateway-protected (C8Y auth via the dedicated technical user); there
 * is no anonymous access. `stream:true` requests are relayed as a real chunked
 * `text/event-stream` response (SSE multiplexed over the tunnel); everything else is
 * buffered into a single JSON body.
 */
import { defineEventHandler, setResponseHeader, setResponseStatus } from 'nitro/h3'
import { useLogger } from 'c8y-nitro/utils'
import { hasPeer, sendRequest, sendRequestStreaming } from '../../lib/bridge'

function clip(value: string, max = 1500): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}

function extractFirstOutputText(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null
  const output = (parsed as { output?: unknown }).output
  if (!Array.isArray(output)) return null
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if ((part as { type?: unknown }).type === 'output_text') {
        const text = (part as { text?: unknown }).text
        return typeof text === 'string' ? text : null
      }
    }
  }
  return null
}

export default defineEventHandler(async (event) => {
  const log = useLogger(event)

  if (!hasPeer()) {
    log.set({ channel: 'proxy', action: 'forward-v1', result: 'tunnel_offline' })
    setResponseStatus(event, 503)
    return { error: { message: 'Tunnel offline: the local LM Studio client is not connected.', type: 'tunnel_offline' } }
  }

  const subPath = (event.context.params?.path as string | undefined) ?? ''
  const forwardPath = `/v1/${subPath}${event.url.search}`
  const method = event.req.method
  log.set({ channel: 'proxy', action: 'forward-v1', method, forwardPath })

  let body: string | undefined
  let streamRequested: boolean | null = null
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await event.req.text()
    body = raw === '' ? undefined : raw
    if (body) {
      // Capture whether the caller requested streaming, but forward body as-is.
      try {
        const parsed = JSON.parse(body)
        if (parsed && typeof parsed === 'object' && 'stream' in parsed) {
          streamRequested = Boolean((parsed as { stream?: unknown }).stream)
        }
      }
      catch {
        // Not JSON — forward as-is.
      }
    }
  }

  log.set({
    requestBodyBytes: body ? Buffer.byteLength(body, 'utf8') : 0,
    streamRequested,
  })

  // Streaming path: relay the SSE body chunk-by-chunk. The body is forwarded verbatim
  // (stream:true intact); the Mac replies with response-start/chunk/end frames.
  if (streamRequested === true) {
    try {
      const { status, headers, stream } = await sendRequestStreaming({
        method,
        path: forwardPath,
        headers: { 'content-type': 'application/json' },
        body,
      })
      setResponseStatus(event, status)
      const upstreamContentType = headers['content-type'] ?? 'text/event-stream'
      // NOTE: we deliberately do NOT echo `text/event-stream` back. evlog's Nitro-v3
      // plugin (bundled by c8y-nitro, dev AND prod) detects streaming responses by
      // content-type / transfer-encoding and tries to reassign `event.res` to wrap
      // them for logging — but h3 v2 makes `event.res` getter-only, so that throws a
      // 500. Sending `text/plain` keeps the response a real chunked stream while
      // dodging that detection. The body bytes are the SSE payload, verbatim.
      const outgoingContentType = 'text/plain; charset=utf-8'
      setResponseHeader(event, 'content-type', outgoingContentType)
      // SSE hygiene: never let an intermediary buffer or transform the stream.
      setResponseHeader(event, 'cache-control', 'no-cache, no-transform')
      log.set({ upstreamStatus: status, upstreamContentType, outgoingContentType, streaming: true })
      return stream
    }
    catch (err) {
      log.set({
        result: 'tunnel_error',
        streaming: true,
        error: err instanceof Error ? err.message : String(err),
      })
      setResponseStatus(event, 502)
      return { error: { message: err instanceof Error ? err.message : String(err), type: 'tunnel_error' } }
    }
  }

  try {
    const resp = await sendRequest({
      method,
      path: forwardPath,
      headers: { 'content-type': 'application/json' },
      body,
    })
    setResponseStatus(event, resp.status)
    const contentType = resp.headers['content-type'] ?? 'application/json'
    const isEventStream = contentType.toLowerCase().includes('text/event-stream')
    // Workaround: c8y-nitro/evlog currently crashes in onResponse for event-stream
    // content types in this runtime. We still return the SSE payload body verbatim,
    // but with a plain-text content type so response hooks complete successfully.
    const outgoingContentType = isEventStream ? 'text/plain; charset=utf-8' : contentType
    setResponseHeader(event, 'content-type', outgoingContentType)
    log.set({
      upstreamStatus: resp.status,
      upstreamContentType: contentType,
      outgoingContentType,
      upstreamBodyBytes: Buffer.byteLength(resp.body, 'utf8'),
    })

    // For JSON responses, return an object so callers always receive valid JSON,
    // not a plain string payload that some SDK wrappers fail to parse reliably.
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(resp.body) as Record<string, unknown>
        const output = parsed.output
        log.set({
          responseShape: {
            topLevelKeys: Object.keys(parsed).slice(0, 20),
            id: typeof parsed.id === 'string' ? parsed.id : null,
            object: typeof parsed.object === 'string' ? parsed.object : null,
            status: typeof parsed.status === 'string' ? parsed.status : null,
            outputCount: Array.isArray(output) ? output.length : null,
            outputTypes: Array.isArray(output)
              ? output.slice(0, 10).map(item => (item && typeof item === 'object' && 'type' in item)
                ? String((item as { type?: unknown }).type)
                : typeof item)
              : null,
            firstOutputTextPreview: clip(extractFirstOutputText(parsed) ?? '<none>', 500),
          },
        })
        return parsed
      }
      catch (parseError) {
        log.set({
          jsonParseFailed: true,
          jsonParseError: parseError instanceof Error ? parseError.message : String(parseError),
          responseBodyPreview: clip(resp.body),
        })
        // If upstream sent invalid JSON, fall back to the raw body.
      }
    }

    // Non-JSON responses are forwarded as raw text (including SSE payloads).
    log.set({ responseBodyPreview: clip(resp.body) })
    return resp.body
  }
  catch (err) {
    log.set({
      result: 'tunnel_error',
      error: err instanceof Error ? err.message : String(err),
    })
    setResponseStatus(event, 502)
    return { error: { message: err instanceof Error ? err.message : String(err), type: 'tunnel_error' } }
  }
})
