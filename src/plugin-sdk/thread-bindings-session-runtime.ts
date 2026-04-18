export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";

type ThreadBindingLifecycleRecord = {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export function resolveThreadBindingLifecycle(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): {
  expiresAt?: number;
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

  const inactivityExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

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
