// Heartbeat wake reasons are displayed/logged, so normalize blanks to a stable
// default before they reach scheduling or diagnostics.
/** Normalize a heartbeat wake reason for logs and UI. */
export function normalizeHeartbeatWakeReason(reason?: string): string {
  return reason?.trim() || "requested";
}
