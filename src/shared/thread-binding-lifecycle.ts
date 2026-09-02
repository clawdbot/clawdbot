/** Persisted timestamps and optional TTL overrides for one channel thread binding. */
export type ThreadBindingLifecycleRecord = {
  /** Epoch milliseconds when the binding was created. */
  boundAt: number;
  /** Epoch milliseconds of the latest activity seen for the bound conversation. */
  lastActivityAt: number;
  /** Optional idle timeout override in milliseconds; zero disables idle expiry. */
  idleTimeoutMs?: number;
  /** Optional max-age override in milliseconds; zero disables max-age expiry. */
  maxAgeMs?: number;
};

/** Resolves the next expiration for a channel thread binding from idle and max-age limits. */
export function resolveThreadBindingLifecycle(params: {
  /** Stored binding timestamps and optional timeout overrides. */
  record: ThreadBindingLifecycleRecord;
  /** Fallback idle timeout in milliseconds when the record has no override. */
  defaultIdleTimeoutMs: number;
  /** Fallback max-age timeout in milliseconds when the record has no override. */
  defaultMaxAgeMs: number;
}): {
  /** Earliest expiration timestamp, omitted when both limits are disabled. */
  expiresAt?: number;
  /** Expiration source corresponding to `expiresAt`. */
  reason?: "idle-expired" | "max-age-expired";
} {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;

  // Activity imported from older stores may predate the binding; never expire before bind time.
  const inactivityExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

  // The lifecycle reports the first real reason so callers can prune or surface it accurately.
  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return inactivityExpiresAt <= maxAgeExpiresAt
      ? { expiresAt: inactivityExpiresAt, reason: "idle-expired" }
      : { expiresAt: maxAgeExpiresAt, reason: "max-age-expired" };
  }
  if (inactivityExpiresAt != null) {
    return { expiresAt: inactivityExpiresAt, reason: "idle-expired" };
  }
  if (maxAgeExpiresAt != null) {
    return { expiresAt: maxAgeExpiresAt, reason: "max-age-expired" };
  }
  return {};
}
