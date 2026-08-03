/** Default timeout for iMessage probe/RPC operations (10 seconds). */
export const DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS = 10_000;

// imsg waits up to 150s for a private-bridge send, then auto transport can fall
// back to AppleScript and spend up to 8s verifying the persisted row. The outer
// RPC timeout must outlive both stages; matching imsg's 150s deadline turns a
// successful fallback into an ambiguous timeout that callers may retry.
export const DEFAULT_IMESSAGE_SEND_TIMEOUT_MS = 180_000;
