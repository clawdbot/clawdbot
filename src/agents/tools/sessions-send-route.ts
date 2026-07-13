import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";

type SessionsSendRouteEntry = Pick<SessionEntry, "acp" | "parentSessionKey" | "spawnedBy">;

export function resolveAcpSessionsSendRoute(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta: SessionAcpMeta | undefined;
  requesterSessionKey: string | null | undefined;
  activeAcpTurn: boolean;
}): { skipA2AFlow: boolean; rejection?: string } {
  const entry =
    params.acpMeta && params.entry ? { ...params.entry, acp: params.acpMeta } : params.entry;
  const skipA2AFlow = isRequesterParentOfBackgroundAcpSession(entry, params.requesterSessionKey);
  if (!skipA2AFlow || params.acpMeta?.mode !== "oneshot") {
    return { skipA2AFlow };
  }
  const identity = params.acpMeta.identity;
  const hasStableIdentity = Boolean(
    normalizeOptionalString(identity?.agentSessionId) ??
    normalizeOptionalString(identity?.acpxSessionId),
  );
  if (!params.activeAcpTurn && hasStableIdentity && identity?.sessionResumeSupported === true) {
    return { skipA2AFlow };
  }
  const rejection =
    !params.activeAcpTurn && hasStableIdentity
      ? "sessions_send cannot resume this ACP one-shot because its agent does not support session resume. "
      : 'sessions_send cannot interrupt running ACP mode="run" one-shot sessions or resume one-shots before a stable ACP session id is recorded. ';
  return {
    skipA2AFlow,
    rejection:
      rejection +
      "Use session_status or the task result for progress, " +
      'spawn ACP with mode="session" and thread=true for follow-up turns, ' +
      "or use a native subagent for steerable background work.",
  };
}

export function isRequesterParentOfNativeSubagentSession(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta?: unknown;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
}): boolean {
  if (
    !params.entry ||
    params.acpMeta ||
    params.entry.acp ||
    !isSubagentSessionKey(params.targetSessionKey)
  ) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}
