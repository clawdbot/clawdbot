import type { ServerResponse } from "node:http";
import { EventEncoder } from "@ag-ui/encoder";

/**
 * Commits SSE response headers and returns the encoder that produced them.
 *
 * The encoder is deliberately built WITHOUT the request's `Accept` header.
 * `EventEncoder.getContentType()` advertises the protobuf media type when Accept
 * prefers it, but `encode()` always returns SSE text — only `encodeBinary()`
 * emits protobuf. Forwarding Accept therefore labels an SSE body as protobuf and
 * breaks client parsing. This channel speaks SSE only, so it advertises exactly
 * what it writes. Serving protobuf would mean switching the whole write path to
 * `encodeBinary`; that is deliberately not implemented here.
 *
 * Callers must commit headers only AFTER claiming the run: once these are
 * flushed the response is committed and the 409 conflict path can no longer call
 * `setHeader`.
 */
export function beginSseResponse(res: ServerResponse): EventEncoder {
  const encoder = new EventEncoder();
  res.statusCode = 200;
  res.setHeader("Content-Type", encoder.getContentType());
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return encoder;
}
