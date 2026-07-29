// Normalizes heartbeat wake reasons for logs and UI.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Heartbeat wake reasons are displayed/logged, so normalize blanks to a stable
// default before they reach scheduling or diagnostics.
/** Normalize a heartbeat wake reason for logs and UI. */
export function normalizeHeartbeatWakeReason(reason?: string): string {
  return normalizeOptionalString(reason) ?? "requested";
}
