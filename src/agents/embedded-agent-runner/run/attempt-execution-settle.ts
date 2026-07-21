/** Runs prompt dispatch, stream settlement, cleanup, and result projection. */
import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { settleRequesterAfterSessionSpawns } from "../../subagent-registry.js";
import type { NormalizedUsage } from "../../usage.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import type {
  EmbeddedAttemptExecutionPhaseInput,
  EmbeddedAttemptExecutionState,
} from "./attempt-execution-types.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import { finalizeEmbeddedAttemptStreamPhase } from "./attempt-stream-finalize.js";
import type { prepareEmbeddedAttemptStreamRuntime } from "./attempt-stream-runtime-prepare.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type PreparedStreamRuntime = Awaited<ReturnType<typeof prepareEmbeddedAttemptStreamRuntime>>;

type StreamCleanupInput = {
  attempt: EmbeddedRunAttemptParams;
  clearAttemptTimeoutTimers: () => void;
  isProbeSession: boolean;
  queueHandle: PreparedStreamRuntime["stream"]["queueHandle"];
  removeAttemptAbortSignalListener: () => void;
  state: EmbeddedAttemptExecutionState;
  unsubscribe: () => void;
};

function cleanupEmbeddedAttemptStreamExecution(input: StreamCleanupInput): void {
  const { attempt, state } = input;
  input.clearAttemptTimeoutTimers();
  if (
    !input.isProbeSession &&
    (state.aborted || state.timedOut) &&
    !state.timedOutDuringCompaction
  ) {
    log.debug(
      `run cleanup: runId=${attempt.runId} sessionId=${attempt.sessionId} aborted=${state.aborted} timedOut=${state.timedOut}`,
    );
  }
  try {
    input.unsubscribe();
  } catch (error) {
    // A throwing unsubscribe indicates a resource leak, but must not mask the run error.
    log.error(
      `CRITICAL: unsubscribe failed, possible resource leak: runId=${attempt.runId} ${String(error)}`,
    );
  }
  attempt.replyOperation?.detachBackend(input.queueHandle);
  clearActiveEmbeddedRun(
    attempt.sessionId,
    input.queueHandle,
    attempt.sessionKey,
    attempt.sessionFile,
  );
  input.removeAttemptAbortSignalListener();
}

export async function runEmbeddedAttemptSettledPhase(
  input: EmbeddedAttemptExecutionPhaseInput & {
    getRepairedRejectedThinkingReplay: () => boolean;
    preparedStreamRuntime: PreparedStreamRuntime;
  },
): Promise<EmbeddedRunAttemptResult> {
  const { attempt, state } = input;
  const { bootstrap, bundleTools, sessionRuntime, systemPrompt, toolBase, toolCatalog } =
    input.prepared;
  const {
    agentSession: {
      activeSession,
      clientToolCallSlots,
      hasDeliveredSourceReply,
      hookRunner,
      setActiveSessionSystemPrompt,
      settingsManager,
    },
    anthropicPayloadLogger,
    boundary: sessionBoundary,
    cacheTrace,
    contextGuards,
    preparedUserTurnMessage,
    sessionManager,
    sessionPromptState,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transport: {
      effectiveAgentTransport,
      effectiveExtraParams,
      effectivePromptCacheRetention,
      streamStrategy,
    },
  } = sessionRuntime;
  const { boundaryTimezone, includeBoundaryTimestamp, orphanRepair } = sessionBoundary;
  const { runtimeInfo, systemPromptReport } = systemPrompt;
  const { bootstrapPromptWarning, shouldRecordCompletedBootstrapTurn } = bootstrap;
  const { effectiveTools, emptyExplicitToolAllowlistError, toolSearch } = toolCatalog;
  const { tools, uncompactedEffectiveTools } = bundleTools;
  const { toolSearchTargetTranscriptProjections } = toolBase;
  const hookAgentId = input.setup.sessionAgentId;
  let yieldAborted = false;
  const preparedStreamRuntime = input.preparedStreamRuntime;
  const {
    abortable,
    cache: {
      observabilityEnabled: cacheObservabilityEnabled,
      promptToolNames: promptCacheToolNames,
    },
    history: {
      contextEnginePromptAuthority,
      contextEngineAssemblySucceeded,
      unwindowedContextEngineMessagesForPrecheck,
    },
    isProbeSession,
    onBlockReplyFlush,
    promptActiveSession,
    stream: preparedStream,
    timeout: attemptTimeout,
  } = preparedStreamRuntime;
  const {
    subscription,
    queueHandle,
    stopAcceptingSteerMessages,
    getBeforeAgentFinalizeRevisionReason,
  } = preparedStream;
  const { unsubscribe, waitForPendingEvents } = subscription;
  const {
    getRunAbortDeadlineAtMs,
    clearTimers: clearAttemptTimeoutTimers,
    removeAbortSignalListener: removeAttemptAbortSignalListener,
  } = attemptTimeout;
  let promptCacheChangesForTurn: PromptCacheChange[] | null = null;
  let lastAssistant: AssistantMessage | undefined;
  let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
  let currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  let attemptUsage: NormalizedUsage | undefined;
  let cacheBreak: PromptCacheBreak | null = null;
  let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
  let finalPromptText: string | undefined;
  let messagesSnapshot: AgentMessage[] = [];
  let sessionIdUsed = activeSession.sessionId;
  let sessionFileUsed: string | undefined = attempt.sessionFile;
  let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
  let promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;

  try {
    const { promptStartedAt } = await runEmbeddedAttemptPromptPhase({
      attempt,
      activeSession,
      sessionManager,
      sessionLockController: input.sessionLock.sessionLockController,
      withOwnedSessionWriteLock: input.sessionLock.withOwnedSessionWriteLock,
      getCompactionReserveTokens: () => settingsManager.getCompactionReserveTokens(),
      ...(emptyExplicitToolAllowlistError ? { emptyExplicitToolAllowlistError } : {}),
      assembly: {
        hookRunner,
        hookAgentId,
        diagnosticTrace: input.diagnostics.diagnosticTrace,
        isRawModelRun: input.isRawModelRun,
        ...(orphanRepair ? { orphanRepair } : {}),
        sessionAgentId: input.setup.sessionAgentId,
        runtimeModel: runtimeInfo.model,
        systemPromptText: sessionRuntimeState.systemPromptText,
        setActiveSessionSystemPrompt,
        cache: {
          observabilityEnabled: cacheObservabilityEnabled,
          retention: effectivePromptCacheRetention,
          streamStrategy,
          transport: effectiveAgentTransport,
          toolNames: promptCacheToolNames,
          trace: cacheTrace,
        },
      },
      context: {
        ...(boundaryTimezone ? { boundaryTimezone } : {}),
        includeBoundaryTimestamp,
        isRawModelRun: input.isRawModelRun,
        ...(preparedUserTurnMessage ? { preparedUserTurnMessage } : {}),
        sessionAgentId: input.setup.sessionAgentId,
        setActiveSessionSystemPrompt,
        ...(systemPromptReport ? { systemPromptReport } : {}),
        systemPromptText: sessionRuntimeState.systemPromptText,
        toolResultPromptProjectionState,
      },
      execution: {
        effectiveFsWorkspaceOnly: input.setup.effectiveFsWorkspaceOnly,
        effectiveWorkspace: input.setup.effectiveWorkspace,
        sandbox: input.setup.sandbox,
      },
      googlePromptCache: {
        extraParams: effectiveExtraParams,
        signal: input.runAbortController.signal,
      },
      observation: {
        cacheTrace,
        diagnosticTrace: input.diagnostics.diagnosticTrace,
        effectiveTools,
        hookAgentId,
        hookRunner,
        isRawModelRun: input.isRawModelRun,
        runTrace: input.diagnostics.runTrace,
        streamStrategy,
        systemPromptText: sessionRuntimeState.systemPromptText,
        toolSearchCompacted: toolSearch.compacted,
        tools,
        trajectoryRecorder,
        transport: effectiveAgentTransport,
        uncompactedEffectiveTools,
      },
      preflight: {
        ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
        contextEngineAssemblySucceeded,
        contextEnginePromptAuthority,
        includeBoundaryTimestamp,
        ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
        ...(unwindowedContextEngineMessagesForPrecheck
          ? { unwindowedContextEngineMessagesForPrecheck }
          : {}),
      },
      submission: {
        promptActiveSession,
        sessionPromptState,
        toolResultPromptProjectionState,
        trajectoryRecorder,
      },
      lifecycle: {
        readState: () => ({
          contextBudgetStatus,
          preflightRecovery,
          promptError: state.promptError,
          promptErrorSource,
        }),
        writeState: (nextState) => {
          contextBudgetStatus = nextState.contextBudgetStatus;
          preflightRecovery = nextState.preflightRecovery;
          state.promptError = nextState.promptError;
          promptErrorSource = nextState.promptErrorSource;
        },
        getPrePromptMessageCount: () => sessionRuntimeState.prePromptMessageCount,
        setPrePromptMessageCount: (count) => {
          sessionRuntimeState.prePromptMessageCount = count;
        },
        setCurrentUserTimestampOverride: (override) => {
          sessionBoundary.setCurrentUserTimestampOverride(override);
        },
        setPromptCacheChangesForTurn: (changes) => {
          promptCacheChangesForTurn = changes;
        },
        setFinalPromptText: (prompt) => {
          finalPromptText = prompt;
        },
        markBeforeAgentRunBlocked: (outcome) => {
          state.beforeAgentRunBlocked = true;
          state.beforeAgentRunBlockedBy = outcome.blockedBy;
        },
        markYieldAborted: () => {
          yieldAborted = true;
          state.cleanupYieldAborted = true;
          state.aborted = false;
        },
        readYieldState: input.lifecycle.readYieldState,
        stopAcceptingSteerMessages,
        takePendingMidTurnPrecheckRequest: contextGuards.takePendingMidTurnPrecheckRequest,
      },
    });

    const afterTurn = await finalizeEmbeddedAttemptStreamPhase({
      attempt,
      activeSession,
      sessionManager,
      sessionLockController: input.sessionLock.sessionLockController,
      withOwnedSessionWriteLock: input.sessionLock.withOwnedSessionWriteLock,
      waitForPendingEvents,
      repairedRejectedThinkingReplay: input.getRepairedRejectedThinkingReplay(),
      getRunAbortDeadlineAtMs,
      shouldFlushForContextEngine: () =>
        Boolean(input.activeContextEngine && !getBeforeAgentFinalizeRevisionReason()),
      getBeforeAgentFinalizeRevisionReason,
      getContextEngineAfterTurnCheckpoint: contextGuards.getAfterTurnCheckpoint,
      onSettleErrorState: (settleState) => {
        state.promptError = settleState.promptError;
        promptErrorSource = settleState.promptErrorSource;
      },
      onSettled: (settledStream) => {
        state.promptError = settledStream.promptError;
        promptErrorSource = settledStream.promptErrorSource;
        state.timedOutDuringCompaction = settledStream.timedOutDuringCompaction;
        messagesSnapshot = settledStream.messagesSnapshot;
        sessionIdUsed = settledStream.sessionIdUsed;
        lastAssistant = settledStream.lastAssistant;
        currentAttemptAssistant = settledStream.currentAttemptAssistant;
        currentAttemptCompletedAssistant = settledStream.currentAttemptCompletedAssistant;
        attemptUsage = settledStream.attemptUsage;
        cacheBreak = settledStream.cacheBreak;
        sessionRuntimeState.promptCache = settledStream.promptCache;
      },
      getState: () => ({
        promptError: state.promptError,
        promptErrorSource,
        yieldAborted,
        sessionIdUsed,
        sessionFileUsed,
      }),
      settle: {
        subscription,
        readLifecycleState: () => ({
          aborted: state.aborted,
          timedOut: state.timedOut,
          timedOutDuringCompaction: state.timedOutDuringCompaction,
        }),
        markTimedOutDuringCompaction: () => {
          state.timedOutDuringCompaction = true;
        },
        runAbortSignal: input.runAbortController.signal,
        isProbeSession,
        onBlockReplyFlush,
        abortable,
        prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
        toolSearchTargetTranscriptProjections,
        cache: {
          observabilityEnabled: cacheObservabilityEnabled,
          changesForTurn: promptCacheChangesForTurn,
          retention: effectivePromptCacheRetention,
        },
      },
      afterTurn: {
        activeContextEngine: input.activeContextEngine,
        readLifecycleState: () => ({
          aborted: state.aborted,
          timedOut: state.timedOut,
          idleTimedOut: state.idleTimedOut,
          timedOutDuringCompaction: state.timedOutDuringCompaction,
        }),
        runtime: {
          effectiveWorkspace: input.setup.effectiveWorkspace,
          agentDir: input.agentDir,
          sessionAgentId: input.setup.sessionAgentId,
          resolveActiveContextEnginePluginId: input.resolveActiveContextEnginePluginId,
          shouldRecordCompletedBootstrapTurn,
          cacheTrace,
          anthropicPayloadLogger,
          hookAgentId,
          diagnosticTrace: input.diagnostics.diagnosticTrace,
          skillWorkshopAvailable: uncompactedEffectiveTools.some(
            (tool) => tool.name === "skill_workshop",
          ),
          hookRunner,
          promptStartedAt,
        },
      },
    });
    sessionIdUsed = afterTurn.sessionIdUsed;
    sessionFileUsed = afterTurn.sessionFileUsed;
  } finally {
    cleanupEmbeddedAttemptStreamExecution({
      attempt,
      clearAttemptTimeoutTimers,
      isProbeSession,
      queueHandle,
      removeAttemptAbortSignalListener,
      state,
      unsubscribe,
    });
  }

  const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
  const result = completeEmbeddedAttemptResult({
    attempt,
    subscription,
    state: {
      aborted: state.aborted,
      externalAbort: state.externalAbort,
      timedOut: state.timedOut,
      idleTimedOut: state.idleTimedOut,
      timedOutDuringCompaction: state.timedOutDuringCompaction,
      timedOutDuringToolExecution: state.timedOutDuringToolExecution,
      timedOutByRunBudget: state.timedOutByRunBudget,
      promptError: state.promptError,
      promptErrorSource,
      preflightRecovery,
      sessionIdUsed,
      sessionFileUsed,
      diagnosticTrace: input.diagnostics.diagnosticTrace,
      systemPromptReport,
      finalPromptText,
      messagesSnapshot,
      ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
      lastAssistant,
      currentAttemptAssistant,
      currentAttemptCompletedAssistant,
      attemptUsage,
      promptCache: sessionRuntimeState.promptCache,
      contextBudgetStatus,
      yieldDetected: input.lifecycle.readYieldState().yieldDetected,
      didDeliverSourceReplyViaMessageTool: hasDeliveredSourceReply(),
    },
    clientToolCallSlots,
    hookRunner,
    hookAgentId,
    bootstrapPromptWarning,
    cache: {
      observabilityEnabled: cacheObservabilityEnabled,
      trace: cacheTrace,
      break: cacheBreak,
      changesForTurn: promptCacheChangesForTurn,
      streamStrategy,
    },
    trajectoryRecorder,
  });
  state.trajectoryEndRecorded = true;
  if (attempt.sessionKey && result.acceptedSessionSpawns?.length) {
    settleRequesterAfterSessionSpawns({
      requesterSessionKey: attempt.sessionKey,
      requesterTurnRunId: attempt.runId,
      requesterYielded: result.yieldDetected === true,
      acceptedSessionSpawns: result.acceptedSessionSpawns,
    });
  }
  return result;
}
