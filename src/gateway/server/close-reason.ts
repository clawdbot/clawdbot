// Close reason helpers keep WebSocket handshake failure text within RFC byte limits.
import { Buffer } from "node:buffer";

/**
 * WebSocket close reason utilities.
 */
const CLOSE_REASON_MAX_BYTES = 120;

/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    return "invalid handshake";
  }
  const buf = Buffer.from(reason);
  if (buf.length <= maxBytes) {
    return reason;
  }
  return buf.subarray(0, maxBytes).toString();
}
