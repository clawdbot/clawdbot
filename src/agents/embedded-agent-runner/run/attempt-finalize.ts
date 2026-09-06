/**
 * Finalizes post-turn state, abort resources, and terminal trajectory artifacts.
 * It may assume stream execution and transcript writes are settled.
 */
import { readActiveTranscriptEntryAnchor } from "../../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { projectNestedToolActivityForHooks } from "../../../sessions/nested-tool-activity.js";
import { buildTrajectoryArtifacts } from "../../../trajectory/metadata.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.js";
import { isSignalTimeoutReason } from "../../failover-error.js";
import { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import { finalizeHarnessContextEngineTurn } from "../../harness/context-engine-lifecycle.js";
import type { AgentSession, SessionMessageEntry } from "../../sessions/index.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import { markActiveEmbeddedRunAbandoned, type EmbeddedAgentQueueHandle } from "../runs.js";
import { buildEmbeddedAgentEndContext } from "./agent-end-context.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { buildAfterTurnRuntimeContextFromUsage } from "./attempt-prompt-helpers.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";
import type { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import { shouldPersistCompletedBootstrapTurn } from "./attempt-thread-helpers.js";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import { shouldFlagCompactionTimeout } from "./compaction-timeout.js";
import type { EmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import {
  isEmbeddedRunTerminalInterrupted,
  resolveEmbeddedRunAttemptTerminalOutcome,
} from "./terminal-outcome.js";
import type {
  EmbeddedAttemptExternalAbortController,
  EmbeddedAttemptExecutionState,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
  EmbeddedRunAttemptTrajectoryRecorder,
} from "./types.js";

type FinalizeEmbeddedAttemptParams = {
  result: EmbeddedRunAttemptResult;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder | null;
  synthesizedPayloadCount: number;
  emptyAssistantReplyIsSilent: boolean;
  hasTerminalOutput: boolean;
  silentExpected?: boolean;
  deferredLifecycleOwner?: EmbeddedAttemptDeferredLifecycleOwner;
};

/** Classifies the completed attempt and records its terminal trajectory artifacts. */
export function finalizeEmbeddedAttempt(
  params: FinalizeEmbeddedAttemptParams,
): EmbeddedRunAttemptResult {
  const { result, trajectoryRecorder } = params;
  if (!trajectoryRecorder) {
    return result;
  }
  const terminalState = projectAgentRunAttemptTerminal(result.terminal);
  // Yield ends before message_end, so its lastAssistant—not an earlier cycle—owns visible text.
  const assistant = terminalState.cleanupYieldAborted
    ? result.lastAssistant
    : (result.currentAttemptCompletedAssistant ?? result.currentAttemptAssistant);
  const completionOutcome = resolveEmbeddedRunAttemptTerminalOutcome({
    attempt: result,
    assistant: terminalState.cleanupYieldAborted ? undefined : assistant,
  });
  const stopReason =
    terminalState.cleanupYieldAborted && completionOutcome.status === "ok"
      ? "end_turn"
      : completionOutcome.stopReason;
  const terminal = resolveAttemptTrajectoryTerminal({
    failed: completionOutcome.status === "error",
    interrupted: isEmbeddedRunTerminalInterrupted(completionOutcome),
    assistantTexts: resolveTerminalAssistantTexts({
      assistantTexts: result.assistantTexts,
      lastAssistantStopReason: stopReason,
      lastAssistantVisibleText: resolveFinalAssistantVisibleText(assistant),
    }),
    toolMetas: result.toolMetas,
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    didSendDeterministicApprovalPrompt: result.didSendDeterministicApprovalPrompt === true,
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
    messagingToolSentTargets: result.messagingToolSentTargets,
    successfulCronAdds: result.successfulCronAdds ?? 0,
    synthesizedPayloadCount: params.synthesizedPayloadCount,
    acceptedSessionSpawns: result.acceptedSessionSpawns,
    heartbeatToolResponse: result.heartbeatToolResponse,
    clientToolCalls: result.clientToolCalls,
    yieldDetected: result.yieldDetected,
    lastToolError: result.lastToolError,
    silentExpected: params.silentExpected,
    emptyAssistantReplyIsSilent: params.emptyAssistantReplyIsSilent,
    lastAssistantStopReason: stopReason,
    hasTerminalOutput: params.hasTerminalOutput,
  });
  const promptError = terminalState.promptError
    ? formatErrorMessage(terminalState.promptError)
    : undefined;

  const terminalFields = {
    aborted: terminalState.aborted,
    externalAbort: terminalState.externalAbort,
    timedOut: terminalState.timedOut,
    idleTimedOut: terminalState.idleTimedOut,
    timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
    timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
    timedOutByRunBudget: terminalState.timedOutByRunBudget,
    promptError,
  };

  trajectoryRecorder.recordEvent("model.completed", {
    ...terminalFields,
    promptErrorSource: terminalState.promptErrorSource,
    terminalError: terminal.terminalError,
    usage: result.attemptUsage,
    promptCache: result.promptCache,
    compactionCount: result.compactionCount,
    assistantTexts: result.assistantTexts,
    stopReason,
    finalPromptText: result.finalPromptText,
    messagesSnapshot: result.messagesSnapshot,
  });
  trajectoryRecorder.recordEvent(
    "trace.artifacts",
    buildTrajectoryArtifacts({
      status: terminal.status,
      ...terminalFields,
      promptErrorSource: terminalState.promptErrorSource,
      terminalError: terminal.terminalError,
      usage: result.attemptUsage,
      promptCache: result.promptCache,
      compactionCount: result.compactionCount ?? 0,
      assistantTexts: result.assistantTexts,
      stopReason,
      finalPromptText: result.finalPromptText,
      itemLifecycle: result.itemLifecycle,
      toolMetas: result.toolMetas,
      didSendViaMessagingTool: result.didSendViaMessagingTool,
      successfulCronAdds: result.successfulCronAdds ?? 0,
      messagingToolSentTexts: result.messagingToolSentTexts,
      messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
      messagingToolSentTargets: result.messagingToolSentTargets,
      lastToolError: result.lastToolError,
    }),
  );
  const sessionEndData = {
    status: terminal.status,
    ...terminalFields,
    terminalError: terminal.terminalError,
    stopReason,
  };
  if (params.deferredLifecycleOwner) {
    params.deferredLifecycleOwner.recordSessionEnd(sessionEndData);
  } else {
    trajectoryRecorder.recordEvent("session.ended", sessionEndData);
  }

  return result;
}

/** Runs post-stream context-engine, transcript, cache, and lifecycle work. */
export async function completeEmbeddedAttemptAfterTurn(
  input: EmbeddedAttemptExecutionPhaseInput,
  settled: Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>,
  prompt: {
    yieldAborted: boolean;
    transcriptLeafId: string | null;
    promptStartedAt: number;
    beforeAgentFinalizeRevisionReason?: string;
  },
): Promise<void> {
  const {
    attempt,
    activeContextEngine,
    agentDir,
    resolveActiveContextEnginePluginId,
    state: executionState,
  } = input;
  const { withOwnedTranscriptWrite } = input.sessionLock;
  const { effectiveWorkspace, sessionAgentId } = input.setup;
  const { sessionRuntime, bootstrap, bundleTools, toolBase } = input.prepared;
  const { sessionManager, cacheTrace, anthropicPayloadLogger } = sessionRuntime;
  const { diagnosticTrace } = input.diagnostics;
  const { shouldRecordCompletedBootstrapTurn } = bootstrap;
  const skillWorkshopAvailable = bundleTools.uncompactedEffectiveTools.some(
    (tool) => tool.name === "skill_workshop",
  );
  const { hookRunner } = sessionRuntime.agentSession;
  const { promptStartedAt, yieldAborted, transcriptLeafId } = prompt;
  const { sessionIdUsed, promptError, messagesSnapshot } = settled;
  const { nestedToolActivities } = toolBase;
  const { prePromptMessageCount } = sessionRuntime.state;
  const contextEngineAfterTurnCheckpoint = sessionRuntime.contextGuards.getAfterTurnCheckpoint();
  const { lastCallUsage, promptCache, compactionOccurredThisAttempt } = settled;
  const { beforeAgentFinalizeRevisionReason } = prompt;

  // Context-engine hooks may call runtime LLM capabilities. Only the transcript
  // rewrite callback reacquires the synchronous session write boundary.
  if (activeContextEngine && !beforeAgentFinalizeRevisionReason) {
    const lifecycleState = projectAgentRunAttemptTerminal(executionState.terminal);
    if (attempt.onContextEngineTurnCandidate) {
      const admission = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
      const terminalEntryId = sessionManager.getLeafId() ?? undefined;
      const terminal =
        admission && terminalEntryId
          ? readActiveTranscriptEntryAnchor({
              agentId: admission.agentId,
              sessionId: admission.sessionId,
              sessionKey: admission.sessionKey,
              storePath: admission.storePath,
              entryId: terminalEntryId,
            })
          : undefined;
      if (admission && terminal) {
        attempt.onContextEngineTurnCandidate({
          boundary: { admission, terminal },
          sessionIdUsed,
          sessionKey: attempt.sessionKey,
          sessionTarget: attempt.sessionTarget,
          promptError: Boolean(promptError),
          aborted: lifecycleState.aborted,
          yieldAborted,
          isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
        });
      }
    } else {
      const afterTurnRuntimeContext = buildAfterTurnRuntimeContextFromUsage({
        attempt,
        workspaceDir: effectiveWorkspace,
        agentDir,
        tokenBudget: attempt.contextTokenBudget,
        lastCallUsage,
        promptCache,
        activeAgentId: sessionAgentId,
        contextEnginePluginId: resolveActiveContextEnginePluginId(),
      });
      await finalizeHarnessContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(promptError),
        aborted: lifecycleState.aborted,
        yieldAborted,
        sessionIdUsed,
        sessionKey: attempt.sessionKey,
        sessionTarget: attempt.sessionTarget,
        sessionFile: attempt.sessionFile,
        messagesSnapshot,
        prePromptMessageCount: contextEngineAfterTurnCheckpoint ?? prePromptMessageCount,
        tokenBudget: attempt.contextTokenBudget,
        runtimeContext: afterTurnRuntimeContext,
        contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        providerId: attempt.provider,
        requestedModelId: attempt.requestedModelId,
        modelId: attempt.modelId,
        fallbackReason: attempt.fallbackReason,
        degradedReason: attempt.degradedReason,
        runMaintenance: async (contextParams) =>
          await runContextEngineMaintenance({
            ...contextParams,
            contextEngine: contextParams.contextEngine as never,
            sessionManager: contextParams.sessionManager as never,
            withSessionManagerRewriteLock: withOwnedTranscriptWrite,
            config: attempt.config,
            agentId: sessionAgentId,
            contextEngineAgentId: attempt.contextEngineAgentId,
          }),
        sessionManager,
        config: attempt.config,
        warn: (message) => log.warn(message),
        isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
      });
    }
  }

  if (!beforeAgentFinalizeRevisionReason) {
    await withOwnedTranscriptWrite(async () => {
      const lifecycleState = projectAgentRunAttemptTerminal(executionState.terminal);
      if (
        shouldPersistCompletedBootstrapTurn({
          shouldRecordCompletedBootstrapTurn,
          promptError,
          aborted: lifecycleState.aborted,
          timedOutDuringCompaction: lifecycleState.timedOutDuringCompaction,
          compactionOccurredThisAttempt,
        })
      ) {
        try {
          sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
            timestamp: Date.now(),
            runId: attempt.runId,
            sessionId: attempt.sessionId,
          });
        } catch (entryErr) {
          log.warn(`failed to persist bootstrap completion entry: ${String(entryErr)}`);
        }
      }
    });
  }

  const lifecycleAfterTurn = projectAgentRunAttemptTerminal(executionState.terminal);
  cacheTrace?.recordStage("session:after", {
    messages: messagesSnapshot,
    note: lifecycleAfterTurn.timedOutDuringCompaction
      ? "compaction timeout"
      : promptError
        ? "prompt error"
        : undefined,
  });
  anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

  // A detached run (such as skill experience review) writes no transcript or session record.
  // Firing agent_end would expose maintenance as a normal turn and schedule successor work.
  if (
    attempt.operation !== "settled-tool-finalization" &&
    attempt.sessionPersistence !== "detached" &&
    !beforeAgentFinalizeRevisionReason
  ) {
    const lifecycleForAgentEnd = projectAgentRunAttemptTerminal(executionState.terminal);
    // Abort outranks failure in terminal-outcome precedence: teardown races can
    // stamp an AbortError into promptError, and surfacing it as `error` would
    // make agent_end consumers treat a user abort as an errored completion.
    const agentEndError =
      promptError && !lifecycleForAgentEnd.aborted ? formatErrorMessage(promptError) : undefined;
    const sourceTarget = sessionManager.getSessionTarget();
    let terminalEntry: SessionMessageEntry | undefined;
    let entry = sessionManager.getLeafEntry();
    // Suppressed writes can leave the previous turn as the tail. Partial current
    // turns remain useful, but review must never cross the pre-prompt boundary.
    while (entry && entry.id !== transcriptLeafId) {
      if (!terminalEntry && entry.type === "message") {
        terminalEntry = entry;
      }
      entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
    }
    const reachedPromptBoundary = transcriptLeafId === null || entry?.id === transcriptLeafId;
    runAgentEndSideEffects({
      skillExperienceReviewSource:
        sourceTarget && terminalEntry && reachedPromptBoundary
          ? { ...sourceTarget, entryId: terminalEntry.id }
          : undefined,
      event: {
        messages: projectNestedToolActivityForHooks(messagesSnapshot, nestedToolActivities ?? []),
        success: !lifecycleForAgentEnd.aborted && !promptError,
        error: agentEndError,
        durationMs: Date.now() - promptStartedAt,
      },
      ctx: buildEmbeddedAgentEndContext({
        run: attempt,
        agentId: sessionAgentId,
        agentDir,
        trace: freezeDiagnosticTraceContext(diagnosticTrace),
        skillWorkshopAvailable,
        compacted: compactionOccurredThisAttempt,
      }),
      hookRunner,
    });
  }
}

/**
 * Releases attempt resources when an embedded-agent run aborts.
 */

type AbortLog = {
  warn(message: string): void;
};

type ActiveSessionAbort = (reason?: unknown) => Promise<void>;
type RunAbort = (isTimeout?: boolean, reason?: unknown) => void;

function createAttemptAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("request aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

function createTimeoutAbortReason(): Error {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  return error;
}

function recordAttemptAbort(
  state: Pick<EmbeddedAttemptExecutionState, "terminal">,
  signal: AbortSignal,
  runId: string,
  isTimeout: boolean,
): void {
  state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
    kind: "aborted",
    source: signal.reason === SESSIONS_YIELD_ABORT_REASON ? "yield_cleanup" : "runtime",
  });
  if (isTimeout) {
    state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
      kind: "timeout",
      phase: "prompt",
      source: "runtime",
    });
    if (
      !projectAgentRunAttemptTerminal(state.terminal).timedOutDuringCompaction &&
      countActiveToolExecutions(runId) > 0
    ) {
      state.terminal = mergeAgentRunAttemptTerminal(state.terminal, {
        kind: "timeout",
        phase: "tool_execution",
        source: "observation",
      });
    }
  }
}

/** Owns the external AbortSignal listener and its handoff to the live session. */
export function createEmbeddedAttemptExternalAbortController(input: {
  abortSignal?: AbortSignal;
  cleanupAfterEarlyAbort: () => Promise<void>;
  runAbortController: AbortController;
  runId: string;
  state: Pick<EmbeddedAttemptExecutionState, "terminal">;
}): EmbeddedAttemptExternalAbortController {
  let abortActiveSession: ActiveSessionAbort | undefined;
  let abortRun: RunAbort | undefined;
  let isCompactionPendingOrRetrying: (() => boolean) | undefined;
  let isCompactionInFlight: (() => boolean) | undefined;
  let removeListener: (() => void) | undefined;
  let abortHandled = false;

  const onAbort = () => {
    const signal = input.abortSignal;
    if (!signal || abortHandled) {
      return;
    }
    // Preparation checkpoints and the listener share classification and side effects.
    // Mark before handoff because aborting live work can synchronously re-enter.
    abortHandled = true;
    input.state.terminal = mergeAgentRunAttemptTerminal(input.state.terminal, {
      kind: "aborted",
      source: "external",
    });
    const reason = signal.reason;
    const isTimeout = reason ? isSignalTimeoutReason(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout,
        isCompactionPendingOrRetrying: isCompactionPendingOrRetrying?.() ?? false,
        isCompactionInFlight: isCompactionInFlight?.() ?? false,
      })
    ) {
      input.state.terminal = mergeAgentRunAttemptTerminal(input.state.terminal, {
        kind: "timeout",
        phase: "compaction",
        source: "observation",
      });
    }
    if (abortRun) {
      abortRun(isTimeout, reason);
      return;
    }
    recordAttemptAbort(input.state, input.runAbortController.signal, input.runId, isTimeout);
    input.state.terminal = mergeAgentRunAttemptTerminal(input.state.terminal, {
      kind: "failed",
      source: "prompt",
      error: createAttemptAbortError(signal),
    });
    if (!input.runAbortController.signal.aborted) {
      input.runAbortController.abort(isTimeout ? (reason ?? createTimeoutAbortReason()) : reason);
    }
    void abortActiveSession?.(input.runAbortController.signal.reason);
  };

  const readFiredAbortError = () => {
    const signal = input.abortSignal;
    if (!signal?.aborted) {
      return undefined;
    }
    onAbort();
    return createAttemptAbortError(signal);
  };

  return {
    arm: () => {
      const signal = input.abortSignal;
      if (!signal || removeListener) {
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeListener = () => {
        signal.removeEventListener("abort", onAbort);
        removeListener = undefined;
      };
    },
    dispose: () => {
      removeListener?.();
    },
    setActiveSessionAbort: (abort) => {
      abortActiveSession = abort;
    },
    setCompactionState: (state) => {
      isCompactionPendingOrRetrying = state.isPendingOrRetrying;
      isCompactionInFlight = state.isInFlight;
    },
    setRunAbort: (abort) => {
      abortRun = abort;
    },
    throwIfFired: () => {
      const abortError = readFiredAbortError();
      if (abortError) {
        throw abortError;
      }
    },
    throwIfFiredAfterPrepCleanup: async () => {
      const abortError = readFiredAbortError();
      if (!abortError) {
        return;
      }
      await input.cleanupAfterEarlyAbort();
      throw abortError;
    },
  };
}

/** Builds the live-session abort handler shared by timeouts and explicit cancellation. */
export function createEmbeddedAttemptRunAbort(input: {
  abortActiveSession: ActiveSessionAbort;
  activeSession: Pick<AgentSession, "abortCompaction" | "isCompacting">;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "onAttemptTimeout" | "runId" | "sessionFile" | "sessionId" | "sessionKey"
  >;
  getQueueHandle: () => EmbeddedAgentQueueHandle | undefined;
  isProbeSession: boolean;
  log: AbortLog;
  runAbortController: AbortController;
  state: Pick<EmbeddedAttemptExecutionState, "terminal">;
}): RunAbort {
  let abortAccepted = false;
  const abortCompaction = () => {
    if (!input.activeSession.isCompacting) {
      return;
    }
    try {
      input.activeSession.abortCompaction();
    } catch (error) {
      if (!input.isProbeSession) {
        input.log.warn(
          `embedded run abortCompaction failed: runId=${input.attempt.runId} sessionId=${input.attempt.sessionId} err=${String(error)}`,
        );
      }
    }
  };

  return (isTimeout = false, reason?: unknown) => {
    // Reply-operation cancellation can synchronously re-enter through its abort signal.
    // The attempt owner accepts the first reason so session and lock cleanup run once.
    if (abortAccepted) {
      return;
    }
    abortAccepted = true;
    recordAttemptAbort(
      input.state,
      input.runAbortController.signal,
      input.attempt.runId,
      isTimeout,
    );
    if (isTimeout) {
      const timeoutReason = reason instanceof Error ? reason : createTimeoutAbortReason();
      input.attempt.onAttemptTimeout?.(timeoutReason);
      input.runAbortController.abort(timeoutReason);
    } else {
      input.runAbortController.abort(reason);
    }
    abortCompaction();
    void input.abortActiveSession(input.runAbortController.signal.reason);
    const queueHandle = input.getQueueHandle();
    if (isTimeout && queueHandle) {
      markActiveEmbeddedRunAbandoned({
        sessionId: input.attempt.sessionId,
        handle: queueHandle,
        sessionKey: input.attempt.sessionKey,
        sessionFile: input.attempt.sessionFile,
        reason: "timeout",
      });
    }
  };
}
