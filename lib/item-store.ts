/**
 * In-memory store of Responses-API output items, keyed by their id (`rs_…`, `fc_…`,
 * `msg_…`).
 *
 * Why this exists: the cloud agent drives the OpenAI **Responses API in stateful
 * mode** — after the model produces output items, the follow-up (tool-result) turn
 * does NOT resend them; it sends `{ type: "item_reference", id }` and expects the
 * server to have *stored* those items. LM Studio is stateless and cannot resolve the
 * references (it returns `400 invalid_union` "Invalid type for 'input'"). This store
 * lets the proxy play the role the Responses API server normally would: it captures
 * every output item it sees stream past, so the /v1 relay can expand `item_reference`
 * back into the full item before forwarding to LM Studio.
 *
 * Single replica (see AGENTS.md constraint #1) makes this module-level map correct —
 * the same process that streamed the response also handles the next request.
 */

interface StoredItem {
  item: Record<string, unknown>
  expiresAt: number
}

const store = new Map<string, StoredItem>()

/**
 * Generous TTL: turns usually arrive seconds apart, but a conversation can idle
 * (user walks away) and its references must still resolve when it resumes.
 */
const TTL_MS = 30 * 60_000
/** Backstop against unbounded growth; oldest entries are evicted first. */
const MAX_ENTRIES = 2000

function evict(now: number): void {
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id)
  }
  // Size-cap trimming is logged: a silently evicted item resurfaces later as a
  // mystery `unresolved_item_reference`, so leave a trail.
  let trimmed = 0
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
    trimmed++
  }
  if (trimmed > 0) {
    console.log(JSON.stringify({ tag: 'item-store-evict', trimmed, size: store.size, maxEntries: MAX_ENTRIES }))
  }
}

/** Cache one output item (no-op unless it is an object with a string `id`). */
export function putItem(item: unknown): void {
  if (!item || typeof item !== 'object') return
  const id = (item as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') return
  const now = Date.now()
  // Re-insert so refreshed items count as most-recent for eviction ordering.
  store.delete(id)
  store.set(id, { item: item as Record<string, unknown>, expiresAt: now + TTL_MS })
  evict(now)
}

/** Look up a stored item by id, or undefined if unknown/expired. */
export function getItem(id: string): Record<string, unknown> | undefined {
  const entry = store.get(id)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    store.delete(id)
    return undefined
  }
  return entry.item
}

/** Current number of live entries (diagnostic). */
export function storeCount(): number {
  return store.size
}
