import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveStorePath } from "../../../config/sessions.js";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntries,
  loadSessionEntry,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../../sessions/session-id-resolution.js";
import { resolveDefaultAgentId } from "../../agent-scope.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../../command/session.js";
import { redactRunIdentifier } from "../../workspace-run.js";
import { log } from "../logger.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveAgentHarnessRunAdmissionError } from "./setup.js";

const NO_REAL_CONVERSATION_MESSAGES_REASON = "no real conversation messages";

export function buildContextEngineCompactionSessionTarget(params: {
  agentId?: string;
  config?: RunEmbeddedAgentParams["config"];
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: RunEmbeddedAgentParams["sessionTarget"];
}): ContextEngineSessionTarget {
  const targetAgentId = normalizeOptionalString(params.sessionTarget?.agentId);
  const targetSessionId = normalizeOptionalString(params.sessionTarget?.sessionId);
  const targetSessionKey = normalizeOptionalString(params.sessionTarget?.sessionKey);
  const targetStorePath = normalizeOptionalString(params.sessionTarget?.storePath);
  const completeTarget = Boolean(
    targetAgentId && targetSessionId && targetSessionKey && targetStorePath,
  );
  const marker = completeTarget ? undefined : parseSqliteSessionFileMarker(params.sessionFile);
  const suppliedSessionKey = normalizeOptionalString(params.sessionKey);
  const candidateSessionKey = targetSessionKey ?? suppliedSessionKey;
  const candidateKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;
  const suppliedEntry =
    marker && candidateSessionKey
      ? loadSessionEntry({
          agentId: marker.agentId,
          sessionKey: candidateSessionKey,
          storePath: marker.storePath,
        })
      : undefined;
  const markerMatches = marker
    ? listSessionEntries({
        agentId: marker.agentId,
        storePath: marker.storePath,
      }).filter(({ entry }) => entry.sessionId === marker.sessionId)
    : [];
  const preferredMarkerSessionKey = marker
    ? resolvePreferredSessionKeyForSessionIdMatches(
        markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
        marker.sessionId,
      )
    : undefined;
  const markerSessionKey = marker
    ? suppliedEntry?.sessionId === marker.sessionId
      ? candidateSessionKey
      : candidateSessionKey && !suppliedEntry
        ? candidateSessionKey
        : (preferredMarkerSessionKey ?? (markerMatches.length === 0 ? marker.sessionId : undefined))
    : undefined;
  if (marker && !markerSessionKey) {
    throw new Error("Legacy compaction transcript identity is ambiguous");
  }
  if (
    marker &&
    ((targetAgentId && targetAgentId !== marker.agentId) ||
      (targetSessionId && targetSessionId !== marker.sessionId) ||
      (candidateKeyAgentId && candidateKeyAgentId !== marker.agentId) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(marker.storePath)) ||
      (candidateSessionKey && suppliedEntry && suppliedEntry.sessionId !== marker.sessionId))
  ) {
    throw new Error("Legacy compaction transcript identity is inconsistent");
  }
  const sessionKey = completeTarget
    ? targetSessionKey
    : marker
      ? markerSessionKey
      : (targetSessionKey ?? suppliedSessionKey ?? targetSessionId ?? params.sessionId);
  const agentId =
    targetAgentId ??
    marker?.agentId ??
    params.agentId ??
    resolveAgentIdFromSessionKey(sessionKey, resolveDefaultAgentId(params.config ?? {}));
  const storePath =
    targetStorePath ??
    marker?.storePath ??
    resolveStorePath(params.config?.session?.store, { agentId });
  return {
    agentId,
    sessionId: targetSessionId ?? marker?.sessionId ?? params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(storePath ? { storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

export function isNoRealConversationCompactionNoop(params: {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
}): boolean {
  return (
    params.ok === true &&
    params.compacted === false &&
    params.reason === NO_REAL_CONVERSATION_MESSAGES_REASON
  );
}

export async function resetNoRealConversationTokenSnapshot(params: {
  config?: RunEmbeddedAgentParams["config"];
  sessionKey?: string;
  agentId?: string;
}): Promise<void> {
  if (!params.sessionKey) {
    return;
  }
  const storePath = resolveStorePath(params.config?.session?.store, { agentId: params.agentId });
  try {
    await updateSessionEntry(
      {
        storePath,
        sessionKey: params.sessionKey,
      },
      async () => ({
        totalTokens: 0,
        totalTokensFresh: true,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        contextBudgetStatus: undefined,
        updatedAt: Date.now(),
      }),
      {
        skipMaintenance: true,
        takeCacheOwnership: true,
      },
    );
  } catch (err) {
    log.warn(
      `[context-overflow-precheck] failed to reset stale context snapshot for ` +
        `${params.sessionKey}: ${String(err)}`,
    );
  }
}

/** Best-effort read-only session-key lookup for callers that only provide sessionId. */
export function backfillSessionKey(params: {
  config: RunEmbeddedAgentParams["config"];
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return trimmed;
  }
  if (!params.config || !params.sessionId) {
    return undefined;
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          cfg: params.config,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : resolveSessionKeyForRequest({
          cfg: params.config,
          sessionId: params.sessionId,
          clone: false,
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (err) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export function assertAgentHarnessRunAdmission(params: RunEmbeddedAgentParams): void {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const admissionAgentId = params.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath =
    normalizeOptionalString(params.sessionTarget?.storePath) ??
    resolveStorePath(params.config?.session?.store, { agentId: admissionAgentId });
  const durableEntry = loadSessionEntry({
    ...(admissionAgentId ? { agentId: admissionAgentId } : {}),
    readConsistency: "latest",
    sessionKey,
    storePath,
  });
  const admissionError = resolveAgentHarnessRunAdmissionError({
    agentHarnessId: params.agentHarnessId,
    entry: durableEntry,
    modelSelectionLocked: params.modelSelectionLocked,
    sessionId: params.sessionId,
    sessionKey,
  });
  if (admissionError) {
    throw new Error(admissionError);
  }
}
