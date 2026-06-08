/** Default timeout for iMessage probe/RPC operations (10 seconds). */
export const DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS = 10_000;

// Sends get a much longer default than probes: on macOS 26 (Tahoe) the private
// API bridge intermittently stalls up to ~124s before the send completes. The
// 10s probe timeout aborts those mid-flight, and non-recoverable shapes
// (attachment/reply) are then lost. This must clear the observed upper bound
// plus headroom, otherwise the long tail of stalls still loses sends — 150s
// covers 124s with margin. Decoupling keeps probes/health checks fast while
// letting real sends ride out the stall. Akin to the BlueBubbles fix (#69193).
export const DEFAULT_IMESSAGE_SEND_TIMEOUT_MS = 150_000;
