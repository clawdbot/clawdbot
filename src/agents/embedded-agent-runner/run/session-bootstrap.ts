import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveStorePath } from "../../../config/sessions.js";
import { loadSessionEntry, updateSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
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
  agentId: string;
  config?: RunEmbeddedAgentParams["config"];
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: RunEmbeddedAgentParams["sessionTarget"];
}): ContextEngineSessionTarget {
  const agentId = params.sessionTarget?.agentId ?? params.agentId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey ?? params.sessionId;
  const storePath =
    params.sessionTarget?.storePath ?? resolveStorePath(params.config?.session?.store, { agentId });
  return {
    agentId,
    sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
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
