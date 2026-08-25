import type { SessionsPatchManyTarget } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";

export type SessionPatchTargetIdentity = Pick<
  SessionsPatchManyTarget,
  "agentId" | "expectedLifecycleRevision" | "expectedMarkedUnreadAt" | "expectedSessionId" | "key"
>;

const CONDITIONAL_UNREAD_ACK_ALLOWED_KEYS = new Set([
  "agentId",
  "expectedLifecycleRevision",
  "expectedMarkedUnreadAt",
  "expectedSessionId",
  "key",
  "unread",
]);

export function validateSessionUnreadAck(
  patch: { unread?: boolean },
  expectedMarkedUnreadAt: number | null | undefined,
): string | undefined {
  if (expectedMarkedUnreadAt === undefined) {
    return undefined;
  }
  const hasOtherMutation = Object.entries(patch).some(
    ([key, value]) => value !== undefined && !CONDITIONAL_UNREAD_ACK_ALLOWED_KEYS.has(key),
  );
  return patch.unread === false && !hasOtherMutation
    ? undefined
    : "expectedMarkedUnreadAt requires unread=false as the only mutation.";
}

export function resolveSessionUnreadAck(
  entry: SessionEntry | undefined,
  expectedMarkedUnreadAt: number | null | undefined,
): { kind: "apply" | "missing" } | { kind: "stale"; entry: SessionEntry } {
  if (expectedMarkedUnreadAt === undefined) {
    return { kind: "apply" };
  }
  if (!entry) {
    return { kind: "missing" };
  }
  return (entry.markedUnreadAt ?? null) === expectedMarkedUnreadAt
    ? { kind: "apply" }
    : { kind: "stale", entry };
}
