import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";

type SessionsSendRouteEntry = Pick<
  SessionEntry,
  "acp" | "endedAt" | "parentSessionKey" | "spawnedBy" | "status"
>;

function isRequesterParentOfEntry(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  requesterSessionKey: string | null | undefined;
}): boolean {
  if (!params.entry) {
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

function isLegacyTerminalAcpOneShot(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta: SessionAcpMeta | undefined;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
  configuredAcpAgentIds: readonly string[];
  allowAnyAcpAgent: boolean;
}): boolean {
  if (
    !params.entry ||
    params.acpMeta ||
    params.entry.acp ||
    params.entry.status !== "done" ||
    !Number.isFinite(params.entry.endedAt) ||
    !isRequesterParentOfEntry(params)
  ) {
    return false;
  }
  const parsed = parseAgentSessionKey(params.targetSessionKey);
  if (!parsed || !parsed.rest.startsWith("acp:") || parsed.rest.startsWith("acp:binding:")) {
    return false;
  }
  const targetAgentId = normalizeAgentId(parsed.agentId);
  return (
    params.allowAnyAcpAgent ||
    params.configuredAcpAgentIds.some(
      (configuredAgentId) => normalizeAgentId(configuredAgentId) === targetAgentId,
    )
  );
}

export function resolveAcpSessionsSendRoute(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta: SessionAcpMeta | undefined;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
  configuredAcpAgentIds: readonly string[];
  allowAnyAcpAgent: boolean;
  activeAcpTurn: boolean;
}): { skipA2AFlow: boolean; deferToTaskCompletion: boolean; rejection?: string } {
  if (isLegacyTerminalAcpOneShot(params)) {
    return {
      skipA2AFlow: true,
      deferToTaskCompletion: false,
      rejection:
        "sessions_send cannot resume this completed legacy ACP one-shot because its resume metadata is no longer available. " +
        'Start a new ACP run or spawn ACP with mode="session" and thread=true for follow-up turns.',
    };
  }
  const entry =
    params.acpMeta && params.entry ? { ...params.entry, acp: params.acpMeta } : params.entry;
  const skipA2AFlow = isRequesterParentOfBackgroundAcpSession(entry, params.requesterSessionKey);
  if (!skipA2AFlow || params.acpMeta?.mode !== "oneshot") {
    return { skipA2AFlow, deferToTaskCompletion: false };
  }
  const identity = params.acpMeta.identity;
  const hasStableIdentity = Boolean(
    normalizeOptionalString(identity?.agentSessionId) ??
    normalizeOptionalString(identity?.acpxSessionId),
  );
  if (
    !params.activeAcpTurn &&
    hasStableIdentity &&
    identity?.sessionResumeSupported === true &&
    identity.sessionResumeReady === true
  ) {
    return { skipA2AFlow, deferToTaskCompletion: true };
  }
  const rejection =
    !params.activeAcpTurn && hasStableIdentity && identity?.sessionResumeSupported !== true
      ? "sessions_send cannot resume this ACP one-shot because its agent does not support session resume. "
      : !params.activeAcpTurn && hasStableIdentity && identity?.sessionResumeReady !== true
        ? "sessions_send cannot resume this ACP one-shot because this session is not ready to resume. "
        : 'sessions_send cannot interrupt running ACP mode="run" one-shot sessions or resume one-shots before a stable ACP session id is recorded. ';
  return {
    skipA2AFlow,
    deferToTaskCompletion: false,
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
  return isRequesterParentOfEntry(params);
}
