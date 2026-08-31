import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export const GLOBAL_HEARTBEAT_WAKE_TARGET_KEY = "::";

type HeartbeatWakeReadiness = {
  readyAtMs?: number;
  notBeforeMs?: number;
};

export function normalizeHeartbeatWakeTarget(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed || undefined;
}

export function resolveHeartbeatWakeTargetKey(params: {
  agentId?: string;
  sessionKey?: string;
}): string {
  const agentId = normalizeHeartbeatWakeTarget(params.agentId);
  const sessionKey = normalizeHeartbeatWakeTarget(params.sessionKey);
  // A canonical session owns serialization. Some callers also carry the
  // already-derived agent id; that redundant routing fact must not split one
  // session into two concurrent target groups.
  return sessionKey ? `::${sessionKey}` : `${agentId ?? ""}::`;
}

export function isHeartbeatWakeAfterGlobalBarrier(
  targetKey: string,
  enqueueSequence: number,
  barrierSequence: number | undefined,
): boolean {
  return (
    barrierSequence !== undefined &&
    targetKey !== GLOBAL_HEARTBEAT_WAKE_TARGET_KEY &&
    enqueueSequence >= barrierSequence
  );
}

export function isHeartbeatWakeTargetGroupReady(
  group:
    | {
        blockedUntilMs?: number;
        task?: HeartbeatWakeReadiness;
        scheduled?: HeartbeatWakeReadiness;
        event?: HeartbeatWakeReadiness;
      }
    | undefined,
  now: number,
): boolean {
  if (!group || (group.blockedUntilMs !== undefined && group.blockedUntilMs > now)) {
    return false;
  }
  return [group.task, group.scheduled, group.event].some(
    (pending) =>
      pending !== undefined &&
      (pending.readyAtMs === undefined || pending.readyAtMs <= now) &&
      (pending.notBeforeMs === undefined || pending.notBeforeMs <= now),
  );
}
