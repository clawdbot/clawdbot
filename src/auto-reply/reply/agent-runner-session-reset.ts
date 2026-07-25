import { clearBootstrapSnapshotOnSessionBoundary } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
// Handles session reset requests produced during agent runner execution.
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery-state.js";
import type { SessionEntry } from "../../config/sessions.js";
import { persistSessionResetLifecycle } from "../../config/sessions/session-accessor.js";
import {
  formatSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
} from "../../config/sessions/sqlite-marker.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
} from "../../sessions/model-overrides.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";

type ResetSessionOptions = {
  failureLabel: string;
  buildLogMessage: (nextSessionId: string) => string;
  cleanupTranscripts?: boolean;
};

const deps = {
  generateSecureUuid,
  persistSessionResetLifecycle,
  refreshQueuedFollowupSession,
  error: (message: string) => defaultRuntime.error(message),
};

function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void {
  Object.assign(deps, {
    generateSecureUuid,
    persistSessionResetLifecycle,
    refreshQueuedFollowupSession,
    error: (message: string) => defaultRuntime.error(message),
    ...overrides,
  });
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentRunnerSessionResetTestApi")
  ] = { setAgentRunnerSessionResetTestDeps };
}

export async function resetReplyRunSession(params: {
  options: ResetSessionOptions;
  sessionKey?: string;
  queueKey: string;
  activeSessionEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  messageThreadId?: string;
  followupRun: FollowupRun;
  onActiveSessionEntry: (entry: SessionEntry) => void;
  onNewSession: (newSessionId: string, nextSessionFile: string) => void;
}): Promise<boolean> {
  if (!params.sessionKey || !params.activeSessionStore || !params.storePath) {
    return false;
  }
  const prevEntry = params.activeSessionStore[params.sessionKey] ?? params.activeSessionEntry;
  if (!prevEntry) {
    return false;
  }
  if (isModelSelectionLocked(prevEntry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
  const nextSessionId = prevEntry.sessionId;
  const now = Date.now();
  const nextEntry: SessionEntry = {
    ...prevEntry,
    sessionId: nextSessionId,
    previousSessionId: undefined,
    lifecycleRevision: deps.generateSecureUuid(),
    updatedAt: now,
    sessionStartedAt: now,
    lastInteractionAt: now,
    systemSent: false,
    abortedLastRun: false,
    modelProvider: undefined,
    model: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    totalTokensFresh: false,
    estimatedCostUsd: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    contextTokens: undefined,
    contextBudgetStatus: undefined,
    systemPromptReport: undefined,
    fallbackNoticeSelectedModel: undefined,
    fallbackNoticeActiveModel: undefined,
    fallbackNoticeReason: undefined,
    compactionCount: 0,
    memoryFlushAt: undefined,
    memoryFlushCompactionCount: undefined,
    memoryFlushContextHash: undefined,
    memoryFlushFailureCount: undefined,
    memoryFlushLastFailedAt: undefined,
    memoryFlushLastFailureError: undefined,
  };
  clearAllCliSessions(nextEntry);
  nextEntry.agentHarnessId = undefined;
  transitionMainSessionRecovery(nextEntry, { kind: "clear" });
  const agentId = params.followupRun.run.agentId;
  const nextSessionFile =
    (sqliteSessionFileMarkerMatchesTarget(prevEntry.sessionFile, {
      agentId,
      sessionId: nextSessionId,
      storePath: params.storePath,
    })
      ? prevEntry.sessionFile
      : undefined) ??
    formatSqliteSessionFileMarker({
      agentId,
      sessionId: nextSessionId,
      storePath: params.storePath,
    });
  nextEntry.sessionFile = nextSessionFile;
  params.activeSessionStore[params.sessionKey] = nextEntry;
  try {
    await deps.persistSessionResetLifecycle({
      agentId,
      nextEntry,
      nextSessionFile,
      previousEntry: prevEntry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  } catch (err) {
    params.activeSessionStore[params.sessionKey] = prevEntry;
    deps.error(
      `Failed to persist session reset after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`,
    );
    throw err;
  }
  clearBootstrapSnapshotOnSessionBoundary({
    boundaryAppended: true,
    sessionKey: params.sessionKey,
  });
  params.followupRun.run.sessionId = nextSessionId;
  params.followupRun.run.sessionFile = nextSessionFile;
  deps.refreshQueuedFollowupSession({
    key: params.queueKey,
    previousSessionId: prevEntry.sessionId,
    nextSessionId,
    nextSessionFile,
  });
  params.onActiveSessionEntry(nextEntry);
  params.onNewSession(nextSessionId, nextSessionFile);
  deps.error(params.options.buildLogMessage(nextSessionId));
  return true;
}
