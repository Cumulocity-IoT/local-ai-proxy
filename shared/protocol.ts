/**
 * Wire protocol for the reverse tunnel between the microservice (cloud) and the
 * Mac client. A single WebSocket multiplexes many concurrent HTTP requests, so
 * every request/response frame is correlated by `id`.
 *
 * Direction:
 *   service → Mac:  RequestFrame, PingFrame
 *   Mac → service:  ResponseFrame, ErrorFrame, PongFrame
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
}

/** LM Studio's response, relayed back to the agent verbatim. */
export interface ResponseFrame {
  type: 'response'
  id: string
  status: number
  headers: Record<string, string>
  /** Raw response body (string). */
  body: string
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
export type ClientFrame = ResponseFrame | ErrorFrame | PingFrame | PongFrame

export type Frame = ServerFrame | ClientFrame

/** Header the Mac client presents on the WS upgrade to authenticate. */
export const TUNNEL_SECRET_HEADER = 'x-tunnel-secret'
