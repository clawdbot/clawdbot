/**
 * Settles async tools and compaction, then snapshots the completed stream.
 */
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import { projectToolSearchTargetTranscriptMessages } from "../../tool-search.js";
import { hasNonzeroUsage, normalizeUsage, type NormalizedUsage } from "../../usage.js";
import { isRunnerAbortError } from "../abort.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import {
  completePromptCacheObservation,
  type PromptCacheBreak,
  type PromptCacheChange,
} from "../prompt-cache-observability.js";
import {
  flushSessionManagerTranscript,
  normalizeCompactionRecoveryTranscriptTail,
} from "./attempt-transcript-helpers.js";
import {
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type CompletionRequiredAsyncTaskWaitResult,
} from "./attempt.async-tasks.js";
import {
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  findLatestUncompactedAttemptUsageSnapshot,
  resolvePromptCacheTouchTimestamp,
} from "./attempt.context-engine-helpers.js";
import type { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt.thread-helpers.js";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";
import { selectCompactionTimeoutSnapshot } from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
type AttemptSessionLockController = Awaited<
  ReturnType<typeof createEmbeddedAttemptSessionLockController>
>;
type PromptCacheRetention = Parameters<typeof buildContextEnginePromptCacheInfo>[0]["retention"];
type ToolSearchTargetTranscriptProjections = Parameters<
  typeof projectToolSearchTargetTranscriptMessages
>[1];
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type StreamSettleResult = {
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  lastAssistant: EmbeddedRunAttemptResult["lastAssistant"];
  currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
  currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  attemptUsage: EmbeddedRunAttemptResult["attemptUsage"];
  cacheBreak: PromptCacheBreak | null;
  lastCallUsage: NormalizedUsage | undefined;
  promptCache: EmbeddedRunAttemptResult["promptCache"];
};

export async function settleEmbeddedAttemptStream(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  sessionLockController: AttemptSessionLockController;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
  subscription: EmbeddedAttemptSubscription;
  state: {
    promptError: unknown;
    promptErrorSource: AgentRunAttemptFailureSource | null;
    yieldAborted: boolean;
    sessionIdUsed: string;
  };
  readLifecycleState: () => {
    aborted: boolean;
    timedOut: boolean;
    timedOutDuringCompaction: boolean;
  };
  markTimedOutDuringCompaction: () => void;
  runAbortDeadlineAtMs: number;
  runAbortSignal: AbortSignal;
  isProbeSession: boolean;
  onBlockReplyFlush?: (payload: {
    reason: "pre_compaction";
    attemptAccepted: boolean;
  }) => Promise<void> | void;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  prePromptMessageCount: number;
  toolSearchTargetTranscriptProjections: ToolSearchTargetTranscriptProjections;
  cache: {
    observabilityEnabled: boolean;
    changesForTurn: PromptCacheChange[] | null;
    retention: PromptCacheRetention;
  };
  shouldFlushForContextEngine: boolean;
}): Promise<StreamSettleResult> {
  const { attempt, activeSession, sessionManager, subscription, state } = input;
  let { promptError, promptErrorSource, sessionIdUsed } = state;

  if (
    shouldWaitForCompletionRequiredAsyncTasks({
      sessionKey: attempt.sessionKey,
      toolMetas: subscription.toolMetas,
      yieldDetected: state.yieldAborted,
    })
  ) {
    const getAsyncStartedToolMetas = () =>
      subscription.toolMetas
        .filter(
          (
            entry,
          ): entry is {
            toolName: string;
            asyncStarted?: boolean;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({
          toolName: entry.toolName,
          asyncStarted: entry.asyncStarted,
          asyncTaskRunId: entry.asyncTaskRunId,
          asyncTaskId: entry.asyncTaskId,
        }));
    const completionRequiredAsyncDeadlineAtMs = Math.max(
      Date.now(),
      input.runAbortDeadlineAtMs - 500,
    );
    let asyncTaskWait: CompletionRequiredAsyncTaskWaitResult;
    try {
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: completionRequiredAsyncDeadlineAtMs,
        abortSignal: input.runAbortSignal,
      });
    } catch (err) {
      if (!input.readLifecycleState().timedOut || !isRunnerAbortError(err)) {
        throw err;
      }
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: Date.now(),
      });
    }
    if (asyncTaskWait.timedOutRunIds.length > 0) {
      promptError = new Error(
        `Timed out waiting for async task completion: ${asyncTaskWait.timedOutRunIds.join(", ")}`,
      );
      promptErrorSource = "prompt";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    } else if (asyncTaskWait.waitedRunIds.length > 0) {
      await input.sessionLockController.waitForSessionEvents(activeSession);
    }
  }

  // Snapshot only outside compaction. Compaction rewrites history in place and
  // cannot be allowed to leave the timeout result with a half-written view.
  const wasCompactingBefore = activeSession.isCompacting;
  const snapshot = activeSession.messages.slice();
  const wasCompactingAfter = activeSession.isCompacting;
  const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
  const preCompactionSessionId = activeSession.sessionId;
  const aggregateTimeoutMs = 60_000;

  try {
    if (input.onBlockReplyFlush) {
      const currentAssistant = findCurrentAttemptAssistantMessage({
        messagesSnapshot: snapshot,
        prePromptMessageCount: input.prePromptMessageCount,
      });
      const attemptAccepted =
        !promptError &&
        !input.readLifecycleState().aborted &&
        !input.readLifecycleState().timedOut &&
        !state.yieldAborted &&
        currentAssistant?.stopReason === "stop";
      await input.onBlockReplyFlush({ reason: "pre_compaction", attemptAccepted });
    }

    const compactionRetryWait = state.yieldAborted
      ? { timedOut: false }
      : await waitForCompactionRetryWithAggregateTimeout({
          waitForCompactionRetry: subscription.waitForCompactionRetry,
          abortable: input.abortable,
          aggregateTimeoutMs,
          isCompactionRetryStillActive: () =>
            hasActiveCompactionRetryWork({
              isCompactionInFlight: subscription.isCompactionInFlight(),
              isSessionStreaming: activeSession.isStreaming,
            }),
        });
    if (compactionRetryWait.timedOut) {
      input.markTimedOutDuringCompaction();
      if (!input.isProbeSession) {
        log.warn(
          `compaction retry aggregate timeout (${aggregateTimeoutMs}ms): ` +
            `proceeding with pre-compaction state runId=${attempt.runId} sessionId=${attempt.sessionId}`,
        );
      }
    }
  } catch (err) {
    if (!isRunnerAbortError(err)) {
      throw err;
    }
    if (!promptError) {
      promptError = err;
      promptErrorSource = "compaction";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    }
    if (!input.isProbeSession) {
      log.debug(`compaction wait aborted: runId=${attempt.runId} sessionId=${attempt.sessionId}`);
    }
  }

  let compactionOccurredThisAttempt = false;
  let messagesSnapshot: AgentMessage[] = [];
  let lastAssistant: AssistantMessage | undefined;
  let currentAttemptAssistant: AssistantMessage | undefined;
  let currentAttemptCompletedAssistant: AssistantMessage | undefined;
  let attemptUsage: EmbeddedRunAttemptResult["attemptUsage"];
  let cacheBreak: PromptCacheBreak | null = null;
  let lastCallUsage: NormalizedUsage | undefined;
  let promptCache: EmbeddedRunAttemptResult["promptCache"];

  await input.sessionLockController.waitForSessionEvents(activeSession);
  await input.withOwnedSessionWriteLock(async () => {
    const { timedOutDuringCompaction } = input.readLifecycleState();
    compactionOccurredThisAttempt = subscription.getCompactionCount() > 0;
    appendAttemptCacheTtlIfNeeded({
      sessionManager,
      timedOutDuringCompaction,
      compactionOccurredThisAttempt,
      config: attempt.config,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      isCacheTtlEligibleProvider,
    });

    if (timedOutDuringCompaction) {
      const removedEntries = normalizeCompactionRecoveryTranscriptTail({
        activeSession,
        sessionManager,
      });
      if (removedEntries > 0 && !input.isProbeSession) {
        log.warn(
          `normalized compaction timeout transcript tail: removedEntries=${removedEntries} ` +
            `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
        );
      }
    }

    const snapshotSelection = selectCompactionTimeoutSnapshot({
      timedOutDuringCompaction,
      preCompactionSnapshot,
      preCompactionSessionId,
      currentSnapshot: activeSession.messages.slice(),
      currentSessionId: activeSession.sessionId,
    });
    if (timedOutDuringCompaction && !input.isProbeSession) {
      log.warn(
        `using ${snapshotSelection.source} snapshot: timed out during compaction ` +
          `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
      );
    }
    messagesSnapshot = projectToolSearchTargetTranscriptMessages(
      snapshotSelection.messagesSnapshot,
      input.toolSearchTargetTranscriptProjections,
    );
    sessionIdUsed = snapshotSelection.sessionIdUsed;
    lastAssistant = messagesSnapshot
      .slice()
      .toReversed()
      .find((message): message is AssistantMessage => message.role === "assistant");
    currentAttemptAssistant = findCurrentAttemptAssistantMessage({
      messagesSnapshot,
      prePromptMessageCount: input.prePromptMessageCount,
    });
    currentAttemptCompletedAssistant = subscription.getCurrentAttemptAssistant();
    attemptUsage = subscription.getUsageTotals();
    cacheBreak = input.cache.observabilityEnabled
      ? completePromptCacheObservation({
          sessionId: attempt.sessionId,
          promptCacheKey: attempt.promptCacheKey,
          sessionKey: attempt.sessionKey,
          usage: attemptUsage,
        })
      : null;
    const transcriptUsageSnapshot = findLatestUncompactedAttemptUsageSnapshot({
      messagesSnapshot,
      prePromptMessageCount: input.prePromptMessageCount,
      compactionOccurred: compactionOccurredThisAttempt,
    });
    const completedAssistantUsage = normalizeUsage(currentAttemptCompletedAssistant?.usage);
    lastCallUsage =
      subscription.getLastAssistantUsage() ??
      (hasNonzeroUsage(completedAssistantUsage)
        ? completedAssistantUsage
        : transcriptUsageSnapshot?.usage);
    // Keep cache timing bound to the assistant that supplied the exact usage.
    // A terminal zero-usage abort must not advance TTL for the previous call.
    const usageAssistant = hasNonzeroUsage(completedAssistantUsage)
      ? currentAttemptCompletedAssistant
      : transcriptUsageSnapshot?.assistant;
    const promptCacheObservation =
      input.cache.observabilityEnabled &&
      (cacheBreak || input.cache.changesForTurn || typeof attemptUsage?.cacheRead === "number")
        ? {
            broke: Boolean(cacheBreak),
            ...(typeof cacheBreak?.previousCacheRead === "number"
              ? { previousCacheRead: cacheBreak.previousCacheRead }
              : {}),
            ...(typeof cacheBreak?.cacheRead === "number"
              ? { cacheRead: cacheBreak.cacheRead }
              : typeof attemptUsage?.cacheRead === "number"
                ? { cacheRead: attemptUsage.cacheRead }
                : {}),
            changes: cacheBreak?.changes ?? input.cache.changesForTurn,
          }
        : undefined;
    const fallbackLastCacheTouchAt = readLastCacheTtlTimestamp(sessionManager, {
      provider: attempt.provider,
      modelId: attempt.modelId,
    });
    promptCache = buildContextEnginePromptCacheInfo({
      retention: input.cache.retention,
      lastCallUsage,
      observation: promptCacheObservation,
      lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
        lastCallUsage,
        assistantTimestamp: usageAssistant?.timestamp,
        fallbackLastCacheTouchAt,
      }),
    });

    if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
      try {
        sessionManager.appendCustomEntry("openclaw:prompt-error", {
          timestamp: Date.now(),
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          api: attempt.model.api,
          error: formatErrorMessage(promptError),
        });
      } catch (entryErr) {
        log.warn(`failed to persist prompt error entry: ${String(entryErr)}`);
      }
    }

    if (input.shouldFlushForContextEngine) {
      flushSessionManagerTranscript(sessionManager);
    }
  });

  return {
    promptError,
    promptErrorSource,
    timedOutDuringCompaction: input.readLifecycleState().timedOutDuringCompaction,
    compactionOccurredThisAttempt,
    messagesSnapshot,
    sessionIdUsed,
    lastAssistant,
    currentAttemptAssistant,
    currentAttemptCompletedAssistant,
    attemptUsage,
    cacheBreak,
    lastCallUsage,
    promptCache,
  };
}
