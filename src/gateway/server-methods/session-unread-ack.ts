import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";

export type SessionPatchTargetIdentity = Pick<
  SessionsPatchParams,
  | "agentId"
  | "expectedLifecycleRevision"
  | "expectedMarkedUnreadAt"
  | "expectedPermissionMode"
  | "expectedSessionId"
  | "expectedToolOverrides"
  | "key"
>;

const CONDITIONAL_UNREAD_ACK_ALLOWED_KEYS = new Set([
  "agentId",
  "expectedLifecycleRevision",
  "expectedMarkedUnreadAt",
  "expectedSessionId",
  "key",
  "unread",
]);

function hasOtherMutation(patch: { unread?: boolean }): boolean {
  return Object.entries(patch).some(
    ([key, value]) => value !== undefined && !CONDITIONAL_UNREAD_ACK_ALLOWED_KEYS.has(key),
  );
}

export function validateSessionUnreadAck(
  patch: { unread?: boolean },
  target: Pick<SessionPatchTargetIdentity, "expectedMarkedUnreadAt">,
): string | undefined {
  if (target.expectedMarkedUnreadAt === undefined) {
    return undefined;
  }
  if (patch.unread === false && !hasOtherMutation(patch)) {
    return undefined;
  }
  return "expectedMarkedUnreadAt requires unread=false as the only mutation.";
}

export function resolveSessionUnreadAck(
  entry: SessionEntry | undefined,
  patch: Pick<SessionsPatchParams, "expectedMarkedUnreadAt" | "unread">,
): { kind: "apply" | "missing" } | { kind: "stale"; entry: SessionEntry } {
  const { expectedMarkedUnreadAt } = patch;
  if (patch.unread !== false || hasOtherMutation(patch) || expectedMarkedUnreadAt === undefined) {
    return { kind: "apply" };
  }
  if (!entry) {
    return { kind: "missing" };
  }
  return (entry.markedUnreadAt ?? null) === expectedMarkedUnreadAt
    ? { kind: "apply" }
    : { kind: "stale", entry };
}
