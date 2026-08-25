import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";

export type SessionPatchTargetIdentity = Pick<
  SessionsPatchParams,
  | "agentId"
  | "expectedLifecycleRevision"
  | "expectedMarkedUnreadAt"
  | "expectedSessionId"
  | "key"
  | "readIntent"
>;

const CONDITIONAL_UNREAD_ACK_ALLOWED_KEYS = new Set([
  "agentId",
  "expectedLifecycleRevision",
  "expectedMarkedUnreadAt",
  "expectedSessionId",
  "key",
  "readIntent",
  "unread",
]);

function hasOtherMutation(patch: { unread?: boolean }): boolean {
  return Object.entries(patch).some(
    ([key, value]) => value !== undefined && !CONDITIONAL_UNREAD_ACK_ALLOWED_KEYS.has(key),
  );
}

export function validateSessionUnreadAck(
  patch: { unread?: boolean },
  target: Pick<SessionPatchTargetIdentity, "expectedMarkedUnreadAt" | "readIntent">,
): string | undefined {
  const { expectedMarkedUnreadAt, readIntent } = target;
  if (expectedMarkedUnreadAt !== undefined && readIntent !== undefined) {
    return "expectedMarkedUnreadAt and readIntent are mutually exclusive.";
  }
  if (expectedMarkedUnreadAt === undefined && readIntent === undefined) {
    return undefined;
  }
  if (patch.unread === false && !hasOtherMutation(patch)) {
    return undefined;
  }
  return readIntent === undefined
    ? "expectedMarkedUnreadAt requires unread=false as the only mutation."
    : "readIntent requires unread=false as the only mutation.";
}

export function resolveSessionUnreadAck(
  entry: SessionEntry | undefined,
  patch: Pick<SessionsPatchParams, "expectedMarkedUnreadAt" | "readIntent" | "unread">,
): { kind: "apply" | "missing" } | { kind: "stale"; entry: SessionEntry } {
  const { expectedMarkedUnreadAt, readIntent } = patch;
  if (patch.unread !== false || hasOtherMutation(patch) || readIntent === "explicit") {
    return { kind: "apply" };
  }
  if (expectedMarkedUnreadAt === undefined) {
    // Stable clients used the same payload for automatic and explicit reads.
    // Preserve a manual marker until a current client declares its intent.
    return entry?.markedUnreadAt === undefined ? { kind: "apply" } : { kind: "stale", entry };
  }
  if (!entry) {
    return { kind: "missing" };
  }
  return (entry.markedUnreadAt ?? null) === expectedMarkedUnreadAt
    ? { kind: "apply" }
    : { kind: "stale", entry };
}
