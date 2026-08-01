// Close reason helpers keep WebSocket handshake failure text within RFC byte limits.
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";

/**
 * WebSocket close reason utilities.
 */
const CLOSE_REASON_MAX_BYTES = 120;

/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    return "invalid handshake";
  }
  return truncateUtf8Prefix(reason, maxBytes);
}
