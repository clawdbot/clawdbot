import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveStorePath, SESSION_TOTAL_TOKENS_VERSION } from "../../../config/sessions.js";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntries,
  loadSessionEntry,
  updateSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../../config/sessions/types.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { emitAgentEventIfCurrent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
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
import {
  AGENT_RUN_SUPERSEDED_ERROR,
  AGENT_RUN_SUPERSEDED_STOP_REASON,
} from "../../run-termination.js";
import { redactRunIdentifier } from "../../workspace-run.js";
import { log } from "../logger.js";
import { supersedeEmbeddedAgentRunByRunId } from "../runs.js";
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
        : preferredMarkerSessionKey
    : undefined;
  if (marker && markerMatches.length > 0 && !markerSessionKey) {
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
      : (targetSessionKey ?? suppliedSessionKey);
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
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
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

type AgentSessionWriterAdmissionSnapshot = {
  agentId?: string;
  entry: InternalSessionEntry;
  sessionKey: string;
  storePath: string;
};

export function assertAgentHarnessRunAdmission(
  params: RunEmbeddedAgentParams,
): AgentSessionWriterAdmissionSnapshot | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
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
  return durableEntry
    ? {
        ...(admissionAgentId ? { agentId: admissionAgentId } : {}),
        entry: durableEntry as InternalSessionEntry,
        sessionKey,
        storePath,
      }
    : undefined;
}

export async function claimAgentSessionWriter(params: RunEmbeddedAgentParams): Promise<
  | {
      expectedLifecycleRevision: string | undefined;
      expectedWriterRunId: string;
    }
  | undefined
> {
  const snapshot = assertAgentHarnessRunAdmission(params);
  if (!snapshot) {
    return undefined;
  }
  const expectedSessionId = params.sessionId;
  const expectedLifecycleRevision = snapshot.entry.lifecycleRevision;
  if (snapshot.entry.sessionId !== expectedSessionId) {
    throw new Error(`Session changed before writer admission: ${snapshot.sessionKey}`);
  }

  const previousWriterRunId = normalizeOptionalString(snapshot.entry.activeWriterRunId);
  const claimed = await updateSessionEntry(
    {
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
      sessionKey: snapshot.sessionKey,
      storePath: snapshot.storePath,
    },
    (entry) => {
      if (
        entry.sessionId !== expectedSessionId ||
        entry.lifecycleRevision !== expectedLifecycleRevision
      ) {
        throw new Error(`Session changed before writer claim commit: ${snapshot.sessionKey}`);
      }
      return {
        activeWriterRunId: params.runId,
      } as Partial<InternalSessionEntry> as Partial<SessionEntry>;
    },
    { skipMaintenance: true },
  );
  if (!claimed || (claimed as InternalSessionEntry).activeWriterRunId !== params.runId) {
    throw new Error(`Session writer claim was not persisted: ${snapshot.sessionKey}`);
  }
  if (previousWriterRunId && previousWriterRunId !== params.runId) {
    // The replacement must own the durable row before the incumbent is made
    // terminal. A failed claim leaves the still-authoritative run untouched.
    const superseded = supersedeEmbeddedAgentRunByRunId(previousWriterRunId, () => {
      const previousLifecycleGeneration =
        getAgentRunContext(previousWriterRunId)?.lifecycleGeneration;
      const recorded = emitAgentEventIfCurrent({
        runId: previousWriterRunId,
        ...(previousLifecycleGeneration
          ? { lifecycleGeneration: previousLifecycleGeneration }
          : {}),
        stream: "lifecycle",
        sessionKey: snapshot.sessionKey,
        sessionId: expectedSessionId,
        ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
        data: {
          phase: "end",
          aborted: true,
          status: AGENT_RUN_SUPERSEDED_STOP_REASON,
          stopReason: AGENT_RUN_SUPERSEDED_STOP_REASON,
          error: AGENT_RUN_SUPERSEDED_ERROR,
          endedAt: Date.now(),
        },
      });
      if (!recorded) {
        throw new Error(`Could not record superseded writer outcome: ${previousWriterRunId}`);
      }
    });
    if (superseded) {
      log.warn(
        `[session-writer] replacing claim session=${sanitizeForLog(snapshot.sessionKey)} ` +
          `previousRunId=${redactRunIdentifier(sanitizeForLog(previousWriterRunId))} ` +
          `nextRunId=${redactRunIdentifier(sanitizeForLog(params.runId))} live=true`,
      );
    }
  }
  return {
    expectedLifecycleRevision,
    expectedWriterRunId: params.runId,
  };
}
