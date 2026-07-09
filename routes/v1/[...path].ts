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
import { getItem, putItem, storeCount } from '../../lib/item-store'

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

/**
 * Diagnostic summary of an OpenAI request body. The load-bearing field for the
 * item-reference problem is `inputItemTypes` / `itemReferenceIds`: when the agent
 * uses the stateful Responses API it stops resending prior items and instead sends
 * `{ type: 'item_reference', id: 'rs_…'|'fc_…' }`, which a stateless LM Studio cannot
 * resolve. `store` / `previousResponseId` tell us whether the agent expects the
 * server to persist items. This is exactly the input Option B (a proxy-side item
 * store) will have to reconstruct.
 */
interface RequestSummary {
  model: string | null
  stream: boolean | null
  toolChoice: unknown
  toolNames: string[]
  toolCount: number
  inputCount: number | null
  inputItemTypes: string[]
  itemReferenceIds: string[]
  hasStore: boolean
  storeValue: unknown
  previousResponseId: string | null
}

function summarizeRequestBody(parsed: unknown): RequestSummary | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  const tools = Array.isArray(obj.tools) ? obj.tools : []
  const toolNames = tools
    .map(t => (t && typeof t === 'object' && 'name' in t ? String((t as { name?: unknown }).name) : null))
    .filter((n): n is string => typeof n === 'string')

  const input = Array.isArray(obj.input) ? obj.input : null
  const inputItemTypes: string[] = []
  const itemReferenceIds: string[] = []
  if (input) {
    for (const item of input) {
      if (!item || typeof item !== 'object') {
        inputItemTypes.push(typeof item)
        continue
      }
      const rec = item as Record<string, unknown>
      if (typeof rec.type === 'string') {
        inputItemTypes.push(rec.type)
        if (rec.type === 'item_reference' && typeof rec.id === 'string') itemReferenceIds.push(rec.id)
      }
      else if (typeof rec.role === 'string') {
        inputItemTypes.push(`message:${rec.role}`)
      }
      else {
        inputItemTypes.push('unknown')
      }
    }
  }

  return {
    model: typeof obj.model === 'string' ? obj.model : null,
    stream: typeof obj.stream === 'boolean' ? obj.stream : null,
    toolChoice: obj.tool_choice ?? null,
    toolNames: toolNames.slice(0, 30),
    toolCount: tools.length,
    inputCount: input ? input.length : null,
    inputItemTypes: inputItemTypes.slice(0, 50),
    itemReferenceIds: itemReferenceIds.slice(0, 50),
    hasStore: 'store' in obj,
    storeValue: 'store' in obj ? obj.store : null,
    previousResponseId: typeof obj.previous_response_id === 'string' ? obj.previous_response_id : null,
  }
}

/** Output-item details from a (buffered) Responses/Chat body — item ids + function calls. */
function summarizeResponseOutput(parsed: unknown): {
  itemTypes: string[]
  itemIds: string[]
  functionCalls: Array<{ name: string | null, callId: string | null, argsPreview: string }>
} | null {
  if (!parsed || typeof parsed !== 'object') return null
  const output = (parsed as { output?: unknown }).output
  if (!Array.isArray(output)) return null
  const itemTypes: string[] = []
  const itemIds: string[] = []
  const functionCalls: Array<{ name: string | null, callId: string | null, argsPreview: string }> = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.type === 'string') itemTypes.push(rec.type)
    if (typeof rec.id === 'string') itemIds.push(rec.id)
    if (rec.type === 'function_call') {
      functionCalls.push({
        name: typeof rec.name === 'string' ? rec.name : null,
        callId: typeof rec.call_id === 'string' ? rec.call_id : null,
        argsPreview: clip(typeof rec.arguments === 'string' ? rec.arguments : JSON.stringify(rec.arguments ?? null), 300),
      })
    }
  }
  return { itemTypes: itemTypes.slice(0, 30), itemIds: itemIds.slice(0, 30), functionCalls: functionCalls.slice(0, 20) }
}

/** Flatten a message/output `content` (string or array of {text} parts) to plain text. */
function itemText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      parts.push((part as { text: string }).text)
    }
  }
  return parts.join('')
}

/**
 * Normalize a stored output item into a canonical, maximally-compatible INPUT item for
 * stateless replay to LM Studio. Returns null for items that must be dropped.
 *
 * Stateful Responses output items carry fields (id, status, annotations, logprobs,
 * output_text content parts, reasoning) that LM Studio's stricter input union rejects
 * (400 invalid_union). We reduce each to the documented input shape — the same thing
 * the AI SDK does when replaying with store:false.
 */
function normalizeReplayItem(item: Record<string, unknown>): unknown | null {
  switch (item.type) {
    case 'reasoning':
      // Ephemeral chain-of-thought; not accepted as input and not needed to continue.
      return null
    case 'message':
      return {
        role: typeof item.role === 'string' ? item.role : 'assistant',
        content: itemText(item.content),
      }
    case 'function_call':
      return {
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      }
    default:
      return item
  }
}

/**
 * Coerce a `function_call_output` item to the canonical shape: `output` must be a plain
 * string, but the agent sends it as an array of `{type:"input_text", text}` parts. Returns
 * the same reference when already canonical (so callers can detect "no change").
 */
function normalizeFunctionCallOutput(item: Record<string, unknown>): unknown {
  if (typeof item.output === 'string') return item
  return { ...item, output: itemText(item.output) }
}

/**
 * Scan captured slices of a streamed SSE body and log a compact summary. Runs when
 * the stream ends (or errors), so it uses `console.log` rather than the request
 * logger — by then evlog has already emitted the request's own log line.
 *
 * We scan the HEAD (start — `response.created`, any early error) plus the TAIL (end —
 * `function_call` items, `response.output_item.done`, `response.completed`), because
 * a model's reasoning stream can be MBs long and the terminal events Option B needs
 * live at the very end.
 */
function logStreamSummary(
  meta: { forwardPath: string, status: number },
  head: string,
  tail: string,
  totalBytes: number,
  fnCalls: Array<{ name: string, args: string }>,
  err?: unknown,
): void {
  const scan = head === tail ? head : `${head}\n…[middle elided]…\n${tail}`
  const unique = (re: RegExp): string[] => {
    const set = new Set<string>()
    for (const m of scan.matchAll(re)) set.add(m[1])
    return [...set].slice(0, 40)
  }
  const sseEventTypes = unique(/"type"\s*:\s*"(response\.[^"]+)"/g)
  const itemIds = unique(/"id"\s*:\s*"((?:rs_|fc_|msg_|resp_|item_)[^"]+)"/g)
  const functionCallNames = unique(/"type"\s*:\s*"function_call"[\s\S]{0,400}?"name"\s*:\s*"([^"]+)"/g)
  const terminalEvents = ['response.completed', 'response.failed', 'response.incomplete', 'response.output_item.done']
    .filter(t => scan.includes(t))
  // A real error is a non-null `"error": { … }` object, a `response.failed` event, or
  // an OpenAI-style error code — NOT the ubiquitous `"error":null` in `response.created`.
  const sawError = /"error"\s*:\s*\{/.test(scan)
    || scan.includes('response.failed')
    || scan.includes('invalid_union')
    || scan.includes('invalid_request_error')
  console.log(JSON.stringify({
    tag: 'v1-stream-summary',
    forwardPath: meta.forwardPath,
    status: meta.status,
    totalBytes,
    sseEventTypes,
    itemIds,
    functionCallNames,
    // The exact tool calls (name + argument JSON) the model emitted this turn — so we
    // can see whether it repeats the same query, indicating a non-converging loop.
    functionCalls: fnCalls.map(f => ({ name: f.name, args: clip(f.args, 300) })),
    sawFunctionCall: functionCallNames.length > 0 || scan.includes('"type":"function_call"'),
    terminalEvents,
    sawError,
    ...(sawError ? { errorPreview: clip(tail, 2000) } : {}),
    ...(err ? { streamError: err instanceof Error ? err.message : String(err) } : {}),
  }))
}

/**
 * Parse one SSE `data:` payload and, if it carries completed output items, cache them
 * in the item store. Both `response.output_item.done` (one item) and the terminal
 * `response.completed` (the full `output` array) are handled; the latter is a safety
 * net in case an item's `.done` event was missed.
 */
function ingestSseDataForStore(payload: string, fnCalls?: Array<{ name: string, args: string }>): void {
  if (payload === '' || payload === '[DONE]') return
  let evt: unknown
  try {
    evt = JSON.parse(payload)
  }
  catch {
    return
  }
  if (!evt || typeof evt !== 'object') return
  const rec = evt as Record<string, unknown>
  if (rec.type === 'response.output_item.done') {
    putItem(rec.item)
    const item = rec.item
    if (fnCalls && item && typeof item === 'object' && (item as { type?: unknown }).type === 'function_call') {
      const r = item as Record<string, unknown>
      fnCalls.push({
        name: typeof r.name === 'string' ? r.name : '<unknown>',
        args: typeof r.arguments === 'string' ? r.arguments : JSON.stringify(r.arguments ?? {}),
      })
    }
  }
  else if (rec.type === 'response.completed') {
    const output = (rec.response as { output?: unknown })?.output
    if (Array.isArray(output)) {
      for (const item of output) putItem(item)
    }
  }
}

/**
 * Pass an SSE body through untouched while capturing a bounded HEAD + rolling TAIL for
 * the end-of-stream diagnostic summary, and — when `storeItems` — parsing each `data:`
 * line into the item store as it streams past (line-buffered, so payloads split across
 * chunks are handled without buffering the whole body). Wrapping only the returned body
 * stream is safe re: the evlog/h3-v2 crash — that hazard is driven by response *headers*
 * (content-type stays `text/plain`), not the body.
 */
function teeForDiagnostics(
  source: ReadableStream<Uint8Array>,
  meta: { forwardPath: string, status: number, storeItems?: boolean },
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const HEAD_MAX = 16_000
  const TAIL_MAX = 200_000
  let head = ''
  let tail = ''
  let totalBytes = 0
  let lineBuffer = ''
  const fnCalls: Array<{ name: string, args: string }> = []
  const append = (text: string): void => {
    if (head.length < HEAD_MAX) head += text.slice(0, HEAD_MAX - head.length)
    tail += text
    if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX)
    if (!meta.storeItems) return
    lineBuffer += text
    let nl = lineBuffer.indexOf('\n')
    while (nl !== -1) {
      const line = lineBuffer.slice(0, nl).replace(/\r$/, '')
      lineBuffer = lineBuffer.slice(nl + 1)
      if (line.startsWith('data:')) ingestSseDataForStore(line.slice(5).trim(), fnCalls)
      nl = lineBuffer.indexOf('\n')
    }
  }
  const flushLineBuffer = (): void => {
    if (meta.storeItems && lineBuffer.startsWith('data:')) {
      ingestSseDataForStore(lineBuffer.slice(5).trim(), fnCalls)
    }
    lineBuffer = ''
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          append(decoder.decode())
          flushLineBuffer()
          logStreamSummary(meta, head, tail, totalBytes, fnCalls)
          controller.close()
          return
        }
        if (value) {
          totalBytes += value.byteLength
          append(decoder.decode(value, { stream: true }))
          controller.enqueue(value)
        }
      }
      catch (err) {
        logStreamSummary(meta, head, tail, totalBytes, fnCalls, err)
        controller.error(err)
      }
    },
    cancel(reason) {
      logStreamSummary(meta, head, tail, totalBytes, fnCalls, reason)
      void reader.cancel(reason)
    },
  })
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
  let requestSummary: RequestSummary | null = null
  let parsedBody: Record<string, unknown> | null = null
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await event.req.text()
    body = raw === '' ? undefined : raw
    if (body) {
      // Capture whether the caller requested streaming + a diagnostic summary of the
      // request shape, but forward the body as-is (no coercion).
      try {
        const parsed = JSON.parse(body)
        if (parsed && typeof parsed === 'object') {
          parsedBody = parsed as Record<string, unknown>
          if ('stream' in parsedBody) streamRequested = Boolean(parsedBody.stream)
          requestSummary = summarizeRequestBody(parsedBody)
        }
      }
      catch {
        // Not JSON — forward as-is.
      }
    }
  }

  let bodyDirty = false

  // Option B — expand `item_reference` into the full stored item. The stateful
  // Responses API references prior output items by id; LM Studio is stateless and
  // rejects unresolved references (400 invalid_union). We substitute the items we
  // captured when they streamed past (see the tee below + lib/item-store).
  const expandedRefs: string[] = []
  const unresolvedRefs: string[] = []
  const droppedRefs: string[] = []
  const toolResults: Array<{ callId: string | null, textPreview: string }> = []
  if (parsedBody && Array.isArray(parsedBody.input)) {
    const input = parsedBody.input as unknown[]
    const rebuilt: unknown[] = []
    let inputChanged = false
    for (const it of input) {
      const type = it && typeof it === 'object' ? (it as { type?: unknown }).type : undefined

      // store-default mode: prior output items arrive as references — resolve from the
      // store, then normalize the resolved item exactly like an inline one.
      if (type === 'item_reference') {
        const id = (it as { id?: unknown }).id
        if (typeof id === 'string') {
          const stored = getItem(id)
          if (stored) {
            const normalized = normalizeReplayItem(stored)
            if (normalized === null) droppedRefs.push(id)
            else {
              expandedRefs.push(id)
              rebuilt.push(normalized)
            }
            inputChanged = true
            continue
          }
          unresolvedRefs.push(id)
        }
        rebuilt.push(it)
        continue
      }

      // store:false mode (and general hardening): prior output items arrive inline as
      // full reasoning/message/function_call objects. LM Studio's input union rejects
      // their native shapes, so normalize them to canonical input items too.
      if (type === 'reasoning' || type === 'message' || type === 'function_call') {
        const normalized = normalizeReplayItem(it as Record<string, unknown>)
        if (normalized === null) {
          inputChanged = true // reasoning dropped
          continue
        }
        if (normalized !== it) inputChanged = true
        rebuilt.push(normalized)
        continue
      }

      if (type === 'function_call_output') {
        const rec = it as Record<string, unknown>
        toolResults.push({
          callId: typeof rec.call_id === 'string' ? rec.call_id : null,
          textPreview: clip(itemText(rec.output), 400),
        })
        const normalized = normalizeFunctionCallOutput(rec)
        if (normalized !== it) inputChanged = true
        rebuilt.push(normalized)
        continue
      }

      rebuilt.push(it)
    }
    if (inputChanged) {
      parsedBody.input = rebuilt
      bodyDirty = true
    }
  }

  if (bodyDirty && parsedBody) body = JSON.stringify(parsedBody)

  log.set({
    requestBodyBytes: body ? Buffer.byteLength(body, 'utf8') : 0,
    streamRequested,
    requestSummary,
    expandedRefs,
    unresolvedRefs,
    droppedRefs,
    toolResults,
    storeSize: storeCount(),
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
      // Tee the SSE body: pass bytes through untouched while (a) capturing a bounded
      // copy for the end-of-stream diagnostic summary and (b) — for the Responses API —
      // parsing each completed output item into the item store so later turns can
      // resolve `item_reference` (Option B).
      return teeForDiagnostics(stream, { forwardPath, status, storeItems: subPath === 'responses' })
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
    if (resp.status >= 400) {
      log.set({ upstreamError: clip(resp.body, 2000) })
    }
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
        // Capture output items so later turns can resolve item_reference (Option B).
        if (subPath === 'responses' && Array.isArray(output)) {
          for (const item of output) putItem(item)
        }
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
            outputItems: summarizeResponseOutput(parsed),
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
