import { clearBootstrapSnapshotOnSessionBoundary } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../../agents/harness/registry.js";
// Handles session reset requests produced during agent runner execution.
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  persistSessionResetLifecycle,
} from "../../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../../config/sessions/session-diff-baseline-capture.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
} from "../../sessions/model-overrides.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
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
  resetRegisteredAgentHarnessSessions,
  error: (message: string) => defaultRuntime.error(message),
};

function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void {
  Object.assign(deps, {
    generateSecureUuid,
    persistSessionResetLifecycle,
    refreshQueuedFollowupSession,
    resetRegisteredAgentHarnessSessions,
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
    lifecycleRunId: undefined,
    lastRunId: undefined,
    modelProvider: undefined,
    model: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
    estimatedCostUsd: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    contextTokens: undefined,
    contextTokensSource: undefined,
    contextBudgetStatus: undefined,
    systemPromptReport: undefined,
    fallbackNotice: undefined,
    sessionDiffBaseline: undefined,
    sessionDiffBaselineCapture: prevEntry.execNode
      ? undefined
      : createSessionDiffBaselineCaptureClaim(),
    compactionCount: 0,
    transcriptByteCompactionLatch: undefined,
    memoryFlush: undefined,
  };
  clearAllCliSessions(nextEntry);
  nextEntry.agentHarnessId = undefined;
  transitionMainSessionRecovery(nextEntry, { kind: "clear" });
  const agentId = params.followupRun.run.agentId;
  const nextSessionFile = params.sessionKey;
  params.activeSessionStore[params.sessionKey] = nextEntry;
  try {
    await deps.persistSessionResetLifecycle({
      agentId,
      nextEntry,
      nextSessionFile,
      previousEntry: prevEntry,
      workspaceDir: params.followupRun.run.workspaceDir,
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
  // A reset can return to the same write-capable turn, so its durable claim must settle before
  // callbacks expose the generation; otherwise pre-reset dirt appears as work from that turn.
  let settledEntry = nextEntry;
  try {
    if (nextEntry.sessionDiffBaselineCapture) {
      settledEntry = await ensureSessionDiffBaseline({
        cwd:
          nextEntry.spawnedCwd ??
          nextEntry.spawnedWorkspaceDir ??
          params.followupRun.run.workspaceDir,
        entry: nextEntry,
        isNewSession: false,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
    }
  } catch (error) {
    // Storage won the generation race; never retain this reset's stale pending snapshot.
    const authoritative = loadSessionEntry({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    if (authoritative) {
      params.activeSessionStore[params.sessionKey] = authoritative;
    } else {
      delete params.activeSessionStore[params.sessionKey];
    }
    throw error;
  }
  params.activeSessionStore[params.sessionKey] = settledEntry;
  clearBootstrapSnapshotOnSessionBoundary({
    boundaryAppended: true,
    sessionKey: params.sessionKey,
  });
  await deps.resetRegisteredAgentHarnessSessions({
    agentId,
    sessionId: nextSessionId,
    sessionKey: params.sessionKey,
    sessionFile: nextSessionFile,
    reason: "reset",
  });
  params.followupRun.run.sessionId = nextSessionId;
  params.followupRun.run.sessionFile = nextSessionFile;
  deps.refreshQueuedFollowupSession({
    key: params.queueKey,
    previousSessionId: prevEntry.sessionId,
    nextSessionId,
    nextSessionFile,
  });
  params.onActiveSessionEntry(settledEntry);
  params.onNewSession(nextSessionId, nextSessionFile);
  deps.error(params.options.buildLogMessage(nextSessionId));
  return true;
}
