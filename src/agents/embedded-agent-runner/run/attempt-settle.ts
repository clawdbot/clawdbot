/**
 * Settles prompt dispatch, stream cleanup, and result projection.
 * It may assume stream runtime preparation and session state are ready.
 */
import type { AssistantMessage } from "../../../llm/types.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptFailureSource,
} from "../../agent-run-terminal-outcome.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import type { AgentMessage } from "../../runtime/index.js";
import { settleRequesterAfterSessionSpawns } from "../../subagents/registry/subagent-registry.js";
import type { NormalizedUsage } from "../../usage.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import { joinWithRunLivenessDeadline, RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import type {
  EmbeddedAttemptExecutionPhaseInput,
  EmbeddedAttemptExecutionState,
} from "./attempt-execution-types.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-finalize.js";
import type { prepareEmbeddedAttemptHistory } from "./attempt-history.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import {
  completeEmbeddedAttemptResult,
  type EmbeddedRunAttemptWithReceiptEvidence,
} from "./attempt-result.js";
import type { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import type { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import type { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** Runs prompt dispatch, stream settlement, cleanup, and result projection. */

type PreparedStreamRuntime = {
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  cache: {
    observabilityEnabled: boolean;
    promptTools: ReturnType<typeof installEmbeddedAttemptStreamGuards>["promptCacheTools"];
  };
  history: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
  isProbeSession: boolean;
  onBlockReplyFlush: Parameters<typeof prepareEmbeddedAttemptStream>[0]["onBlockReplyFlush"];
  promptActiveSession: (
    prompt: string,
    options?: Parameters<
      Parameters<typeof prepareEmbeddedAttemptStream>[0]["activeSession"]["prompt"]
    >[1],
  ) => Promise<void>;
  stream: ReturnType<typeof prepareEmbeddedAttemptStream>;
  timeout: ReturnType<typeof prepareEmbeddedAttemptTimeout>;
};

type StreamCleanupInput = {
  attempt: EmbeddedRunAttemptParams;
  clearAttemptTimeoutTimers: () => void;
  isProbeSession: boolean;
  queueHandle: PreparedStreamRuntime["stream"]["queueHandle"];
  state: EmbeddedAttemptExecutionState;
  unsubscribe: () => void;
};

function cleanupEmbeddedAttemptStreamExecution(input: StreamCleanupInput): Error | undefined {
  const { attempt, state } = input;
  const terminal = projectAgentRunAttemptTerminal(state.terminal);
  input.clearAttemptTimeoutTimers();
  if (
    !input.isProbeSession &&
    (terminal.aborted || terminal.timedOut) &&
    !terminal.timedOutDuringCompaction
  ) {
    log.debug(
      `run cleanup: runId=${attempt.runId} sessionId=${attempt.sessionId} aborted=${terminal.aborted} timedOut=${terminal.timedOut}`,
    );
  }
  // Every release belongs to this owner; one broken callback must not strand
  // the active run or mask the prompt failure that caused teardown.
  let firstCleanupError: Error | undefined;
  for (const [name, cleanup] of [
    ["unsubscribe", input.unsubscribe],
    ["backend detach", () => attempt.replyOperation?.detachBackend(input.queueHandle)],
    [
      "active run cleanup",
      () =>
        clearActiveEmbeddedRun(
          attempt.sessionId,
          input.queueHandle,
          attempt.sessionKey,
          attempt.sessionFile,
        ),
    ],
  ] as const) {
    try {
      cleanup();
    } catch (error) {
      firstCleanupError ??= error instanceof Error ? error : new Error(String(error));
      log.error(
        `CRITICAL: ${name} failed, possible resource leak: runId=${attempt.runId} ${String(error)}`,
      );
    }
  }
  return firstCleanupError;
}

export async function runEmbeddedAttemptSettledPhase(
  input: EmbeddedAttemptExecutionPhaseInput & {
    getRepairedRejectedProviderReplay: () => boolean;
    preparedStreamRuntime: PreparedStreamRuntime;
  },
): Promise<EmbeddedRunAttemptWithReceiptEvidence> {
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
    cache: { observabilityEnabled: cacheObservabilityEnabled, promptTools: promptCacheTools },
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
    getBeforeAgentFinalizeRevisionEntryId,
  } = preparedStream;
  const { unsubscribe, waitForPendingEvents } = subscription;
  const { getRunAbortDeadlineAtMs, clearTimers: clearAttemptTimeoutTimers } = attemptTimeout;
  let promptCacheChangesForTurn: PromptCacheChange[] | null = null;
  let lastAssistant: AssistantMessage | undefined;
  let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
  let currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  let successfulNestedToolNames: EmbeddedRunAttemptWithReceiptEvidence["successfulNestedToolNames"];
  let attemptUsage: NormalizedUsage | undefined;
  let cacheBreak: PromptCacheBreak | null = null;
  let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
  let finalPromptText: string | undefined;
  let messagesSnapshot: AgentMessage[] = [];
  let sessionIdUsed = activeSession.sessionId;
  let sessionFileUsed: string | undefined = attempt.sessionFile;
  let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
  let cleanupError: Error | undefined;
  const readTerminal = () => projectAgentRunAttemptTerminal(state.terminal);
  const setFailure = (error: unknown, source: AgentRunAttemptFailureSource | null) => {
    state.terminal = setAgentRunAttemptTerminalFailure(
      state.terminal,
      error !== null && error !== undefined ? { error, source: source ?? "prompt" } : null,
    );
  };
  const promptToolPolicyBaseline = {
    activeToolNames: activeSession.getActiveToolNames(),
    catalogEntries: [...(toolBase.toolSearchCatalogRef?.current?.entries ?? [])],
  };

  try {
    const { promptStartedAt } = await runEmbeddedAttemptPromptPhase({
      attempt,
      activeSession,
      sessionManager,
      withOwnedTranscriptWrite: input.sessionLock.withOwnedTranscriptWrite,
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
          tools: promptCacheTools,
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
      toolPolicy: {
        baseline: promptToolPolicyBaseline,
        effectiveTools,
        uncompactedEffectiveTools,
        tools,
        codeModeControlsEnabled: toolBase.codeModeControlsEnabledForRun,
        toolSearchCatalogRef: toolBase.toolSearchCatalogRef,
        forceToolNames: [
          ...(toolBase.forceDirectMessageTool ? ["message"] : []),
          ...(attempt.swarmCollector && attempt.swarmOutputSchema ? ["structured_output"] : []),
        ],
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
        readState: () => {
          const terminal = readTerminal();
          return {
            contextBudgetStatus,
            preflightRecovery,
            promptError: terminal.promptError,
            promptErrorSource: terminal.promptErrorSource,
          };
        },
        writeState: (nextState) => {
          contextBudgetStatus = nextState.contextBudgetStatus;
          preflightRecovery = nextState.preflightRecovery;
          setFailure(nextState.promptError, nextState.promptErrorSource);
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
          state.beforeAgentRunBlockedBy = outcome.blockedBy;
        },
        markYieldAborted: () => {
          yieldAborted = true;
          state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
            kind: "aborted",
            source: "yield_cleanup",
          });
        },
        readYieldState: input.lifecycle.readYieldState,
        stopAcceptingSteerMessages,
        takePendingMidTurnPrecheckRequest: contextGuards.takePendingMidTurnPrecheckRequest,
      },
    });

    // Queued subscription handlers (block-reply delivery, tool events) are
    // fire-and-forget during the turn; the pending-events join below is the only
    // place the run waits for them. One hung handler (e.g. a stuck delivery
    // dispatch lane) must not dead-end the turn until the run budget — 48h by
    // default — so the join is bounded and settlement proceeds with a recorded
    // warning instead of producing no visible outcome at all.
    await joinWithRunLivenessDeadline({
      joinWork: waitForPendingEvents,
      runAbortSignal: input.runAbortController.signal,
      onTimeout: () => {
        log.warn(
          `pending subscription events did not settle within ${RUN_LIVENESS_JOIN_TIMEOUT_MS}ms; ` +
            `proceeding to stream settlement: runId=${attempt.runId}`,
        );
      },
    });
    const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
    const beforeAgentFinalizeRevisionEntryId = getBeforeAgentFinalizeRevisionEntryId();
    let rewoundBeforeAgentFinalizeRevision = false;
    if (beforeAgentFinalizeRevisionReason && beforeAgentFinalizeRevisionEntryId) {
      await input.sessionLock.withOwnedTranscriptWrite(() => {
        const rejectedEntry = sessionManager.getEntry(beforeAgentFinalizeRevisionEntryId);
        if (rejectedEntry?.type !== "message" || rejectedEntry.message.role !== "assistant") {
          throw new Error(
            `before_agent_finalize persisted assistant entry is missing or invalid ` +
              `(entry=${beforeAgentFinalizeRevisionEntryId})`,
          );
        }
        // Keep persistence append-only while excluding the rejected draft and
        // every trailing descendant from the hidden retry's active branch.
        sessionManager.appendLeafControl({
          targetId: rejectedEntry.parentId,
          appendParentId: rejectedEntry.parentId,
        });
        rewoundBeforeAgentFinalizeRevision = true;
      });
    }
    let settledStream: Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>;
    try {
      if (input.getRepairedRejectedProviderReplay() && !rewoundBeforeAgentFinalizeRevision) {
        activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
          sessionManager.buildSessionContext().messages,
        );
      }
      const settleTerminal = readTerminal();
      const streamSettleState = {
        promptError: settleTerminal.promptError,
        promptErrorSource: settleTerminal.promptErrorSource,
        yieldAborted,
        sessionIdUsed,
      };
      try {
        settledStream = await settleEmbeddedAttemptStream({
          attempt,
          activeSession,
          sessionManager,
          withOwnedTranscriptWrite: input.sessionLock.withOwnedTranscriptWrite,
          state: streamSettleState,
          runAbortDeadlineAtMs: getRunAbortDeadlineAtMs(),
          shouldFlushForContextEngine: Boolean(
            input.activeContextEngine && !getBeforeAgentFinalizeRevisionReason(),
          ),
          subscription,
          readLifecycleState: () => {
            const terminal = readTerminal();
            return {
              aborted: terminal.aborted,
              timedOut: terminal.timedOut,
              timedOutDuringCompaction: terminal.timedOutDuringCompaction,
            };
          },
          markTimedOutDuringCompaction: () => {
            state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
              kind: "timeout",
              phase: "compaction",
              source: "observation",
            });
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
        });
      } catch (error) {
        // Settlement mutates this shared state before some failures. Publish it so
        // outer teardown keeps the recorded prompt error and attribution.
        setFailure(streamSettleState.promptError, streamSettleState.promptErrorSource);
        throw error;
      }
    } finally {
      if (rewoundBeforeAgentFinalizeRevision) {
        await input.sessionLock.withOwnedTranscriptWrite(() => {
          // Settlement classifies the completed attempt from its original
          // in-memory messages. Later work always sees the rewound branch.
          activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
            sessionManager.buildSessionContext().messages,
          );
        });
      }
    }
    // Publish settled fields before after-turn hooks: those hooks may throw, and
    // outer teardown still needs the completed stream snapshot and usage state.
    setFailure(settledStream.promptError, settledStream.promptErrorSource);
    if (settledStream.timedOutDuringCompaction) {
      state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
        kind: "timeout",
        phase: "compaction",
        source: "observation",
      });
    }
    messagesSnapshot = settledStream.messagesSnapshot;
    sessionIdUsed = settledStream.sessionIdUsed;
    lastAssistant = settledStream.lastAssistant;
    currentAttemptAssistant = settledStream.currentAttemptAssistant;
    currentAttemptCompletedAssistant = settledStream.currentAttemptCompletedAssistant;
    successfulNestedToolNames = settledStream.successfulNestedToolNames;
    attemptUsage = settledStream.attemptUsage;
    cacheBreak = settledStream.cacheBreak;
    sessionRuntimeState.promptCache = settledStream.promptCache;

    const afterTurn = await completeEmbeddedAttemptAfterTurn({
      attempt,
      activeSession,
      sessionManager,
      withOwnedTranscriptWrite: input.sessionLock.withOwnedTranscriptWrite,
      activeContextEngine: input.activeContextEngine,
      readLifecycleState: () => {
        const terminal = readTerminal();
        return {
          aborted: terminal.aborted,
          timedOut: terminal.timedOut,
          idleTimedOut: terminal.idleTimedOut,
          timedOutDuringCompaction: terminal.timedOutDuringCompaction,
        };
      },
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
      state: {
        promptError: settledStream.promptError,
        yieldAborted,
        sessionIdUsed: settledStream.sessionIdUsed,
        sessionFileUsed,
        messagesSnapshot: settledStream.messagesSnapshot,
        prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
        contextEngineAfterTurnCheckpoint: contextGuards.getAfterTurnCheckpoint(),
        lastCallUsage: settledStream.lastCallUsage,
        promptCache: settledStream.promptCache,
        ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
        compactionOccurredThisAttempt: settledStream.compactionOccurredThisAttempt,
      },
    });
    sessionIdUsed = afterTurn.sessionIdUsed;
    sessionFileUsed = afterTurn.sessionFileUsed;
  } finally {
    cleanupError = cleanupEmbeddedAttemptStreamExecution({
      attempt,
      clearAttemptTimeoutTimers,
      isProbeSession,
      queueHandle,
      state,
      unsubscribe,
    });
  }

  if (cleanupError !== undefined) {
    throw cleanupError;
  }

  const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
  const result = completeEmbeddedAttemptResult({
    attempt,
    subscription,
    state: {
      terminal: state.terminal,
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
      successfulNestedToolNames,
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
      requesterAgentId: input.setup.sessionAgentId,
      requesterTurnRunId: attempt.runId,
      requesterYielded: result.yieldDetected === true,
      acceptedSessionSpawns: result.acceptedSessionSpawns,
    });
  }
  return result;
}
