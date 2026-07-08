/**
 * Wire protocol for the reverse tunnel between the microservice (cloud) and the
 * Mac client. A single WebSocket multiplexes many concurrent HTTP requests, so
 * every request/response frame is correlated by `id`.
 *
 * Direction:
 *   service → Mac:  RequestFrame, PingFrame
 *   Mac → service:  ResponseFrame | (ResponseStart→ResponseChunk*→ResponseEnd),
 *                   ErrorFrame, PongFrame
 *
 * Each request is answered by EITHER a single buffered ResponseFrame (when the
 * caller did not request streaming) OR a stream: one ResponseStartFrame, zero or
 * more ResponseChunkFrames, and a terminal ResponseEndFrame — all sharing the
 * request `id`. An ErrorFrame can replace/terminate either shape at any point.
 *
 * This file is shared by both the microservice and mac-client (types only).
 */

/** A forwarded HTTP request the Mac must replay against LM Studio. */
export interface RequestFrame {
  type: 'request'
  id: string
  method: string
  /** Full path to hit on LM Studio, incl. query string, e.g. "/v1/chat/completions". */
  path: string
  headers: Record<string, string>
  /** Raw request body (JSON string) or undefined for GET/HEAD. */
  body?: string
  /**
   * When true, the Mac relays the response chunk-by-chunk (ResponseStart/Chunk/End)
   * instead of buffering it into a single ResponseFrame. Set by the route when the
   * OpenAI request body carries `stream:true`.
   */
  stream?: boolean
}

/** LM Studio's response (buffered), relayed back to the agent verbatim. */
export interface ResponseFrame {
  type: 'response'
  id: string
  status: number
  headers: Record<string, string>
  /** Raw response body (string). */
  body: string
}

/** First frame of a streamed response: status + headers, no body yet. */
export interface ResponseStartFrame {
  type: 'response-start'
  id: string
  status: number
  headers: Record<string, string>
}

/** One slice of a streamed response body (UTF-8 text; SSE payloads are text). */
export interface ResponseChunkFrame {
  type: 'response-chunk'
  id: string
  data: string
}

/** Terminal frame of a streamed response — the body is complete. */
export interface ResponseEndFrame {
  type: 'response-end'
  id: string
}

/** The Mac failed to reach LM Studio (or another local error). */
export interface ErrorFrame {
  type: 'error'
  id: string
  message: string
}

export interface PingFrame { type: 'ping' }
export interface PongFrame { type: 'pong' }

/** Frames the microservice sends to the Mac. */
export type ServerFrame = RequestFrame | PingFrame | PongFrame
/** Frames the Mac sends to the microservice. */
export type ClientFrame =
  | ResponseFrame
  | ResponseStartFrame
  | ResponseChunkFrame
  | ResponseEndFrame
  | ErrorFrame
  | PingFrame
  | PongFrame

export type Frame = ServerFrame | ClientFrame

/** Header the Mac client presents on the WS upgrade to authenticate. */
export const TUNNEL_SECRET_HEADER = 'x-tunnel-secret'
