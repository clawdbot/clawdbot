/**
 * Finalizes post-turn state, abort resources, and terminal trajectory artifacts.
 * It may assume stream execution and transcript writes are settled.
 */

import { readActiveTranscriptEntryAnchor } from "../../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { parseStrictPositiveInteger } from "../../../infra/parse-finite-number.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { buildTrajectoryArtifacts } from "../../../trajectory/metadata.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import type { createCacheTrace } from "../../cache-trace.js";
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.js";
import { isSignalTimeoutReason } from "../../failover-error.js";
import { runAgentEndSideEffects } from "../../harness/agent-end-side-effects.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import type { NormalizedUsage } from "../../usage.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import { markActiveEmbeddedRunAbandoned, type EmbeddedAgentQueueHandle } from "../runs.js";
import { buildEmbeddedAgentEndContext } from "./agent-end-context.js";
import {
  finalizeAttemptContextEngineTurn,
  type buildContextEnginePromptCacheInfo,
} from "./attempt-context-engine-helpers.js";
import { buildAfterTurnRuntimeContextFromUsage } from "./attempt-prompt-helpers.js";
import { shouldPersistCompletedBootstrapTurn } from "./attempt-thread-helpers.js";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";
import { shouldFlagCompactionTimeout } from "./compaction-timeout.js";
import { resolveFinalAssistantVisibleText } from "./helpers.js";
import {
  isEmbeddedRunTerminalInterrupted,
  resolveEmbeddedRunAttemptTerminalOutcome,
} from "./terminal-outcome.js";
import type {
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

  trajectoryRecorder.recordEvent("model.completed", {
    aborted: terminalState.aborted,
    externalAbort: terminalState.externalAbort,
    timedOut: terminalState.timedOut,
    idleTimedOut: terminalState.idleTimedOut,
    timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
    timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
    timedOutByRunBudget: terminalState.timedOutByRunBudget,
    promptError,
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
      aborted: terminalState.aborted,
      externalAbort: terminalState.externalAbort,
      timedOut: terminalState.timedOut,
      idleTimedOut: terminalState.idleTimedOut,
      timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
      timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
      timedOutByRunBudget: terminalState.timedOutByRunBudget,
      promptError,
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
  trajectoryRecorder.recordEvent("session.ended", {
    status: terminal.status,
    aborted: terminalState.aborted,
    externalAbort: terminalState.externalAbort,
    timedOut: terminalState.timedOut,
    idleTimedOut: terminalState.idleTimedOut,
    timedOutDuringCompaction: terminalState.timedOutDuringCompaction,
    timedOutDuringToolExecution: terminalState.timedOutDuringToolExecution,
    timedOutByRunBudget: terminalState.timedOutByRunBudget,
    promptError,
    terminalError: terminal.terminalError,
    stopReason,
  });

  return result;
}

/**
 * Runs post-stream context-engine, transcript, cache, and lifecycle work.
 */

type CacheTrace = ReturnType<typeof createCacheTrace>;
type AnthropicPayloadLogger = ReturnType<typeof createAnthropicPayloadLogger>;
type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type PromptCacheInfo = ReturnType<typeof buildContextEnginePromptCacheInfo>;
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type CompleteEmbeddedAttemptAfterTurnInput = {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: ContextEngine;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
  state: {
    promptError: unknown;
    yieldAborted: boolean;
    sessionIdUsed: string;
    sessionFileUsed?: string;
    messagesSnapshot: AgentMessage[];
    prePromptMessageCount: number;
    contextEngineAfterTurnCheckpoint: number | null;
    lastCallUsage?: NormalizedUsage;
    promptCache?: PromptCacheInfo;
    beforeAgentFinalizeRevisionReason?: string;
    compactionOccurredThisAttempt: boolean;
  };
  readLifecycleState: () => {
    aborted: boolean;
    timedOut: boolean;
    idleTimedOut: boolean;
    timedOutDuringCompaction: boolean;
  };
  runtime: {
    effectiveWorkspace: string;
    agentDir: string;
    sessionAgentId: string;
    resolveActiveContextEnginePluginId: () => string | undefined;
    shouldRecordCompletedBootstrapTurn: boolean;
    cacheTrace: CacheTrace;
    anthropicPayloadLogger: AnthropicPayloadLogger;
    hookAgentId: string;
    diagnosticTrace: Parameters<typeof freezeDiagnosticTraceContext>[0];
    skillWorkshopAvailable: boolean;
    hookRunner: HookRunner;
    promptStartedAt: number;
  };
};

export async function completeEmbeddedAttemptAfterTurn(
  input: CompleteEmbeddedAttemptAfterTurnInput,
): Promise<{ sessionIdUsed: string; sessionFileUsed?: string }> {
  const { attempt, activeContextEngine, sessionManager, state, runtime } = input;
  const { sessionIdUsed, sessionFileUsed } = state;

  // Context-engine hooks may call runtime LLM capabilities. Only the transcript
  // rewrite callback reacquires the synchronous session write boundary.
  if (activeContextEngine && !state.beforeAgentFinalizeRevisionReason) {
    const lifecycleState = input.readLifecycleState();
    const afterTurnRuntimeContext = buildAfterTurnRuntimeContextFromUsage({
      attempt,
      workspaceDir: runtime.effectiveWorkspace,
      agentDir: runtime.agentDir,
      tokenBudget: attempt.contextTokenBudget,
      lastCallUsage: state.lastCallUsage,
      promptCache: state.promptCache,
      activeAgentId: runtime.sessionAgentId,
      contextEnginePluginId: runtime.resolveActiveContextEnginePluginId(),
    });
    const finalizeTurn = async (transcript: {
      messagesSnapshot: AgentMessage[];
      prePromptMessageCount: number;
      sessionManager?: SessionManager;
      withSessionManagerRewriteLock: WithOwnedTranscriptWrite;
    }) => {
      await finalizeAttemptContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(state.promptError),
        aborted: lifecycleState.aborted,
        yieldAborted: state.yieldAborted,
        sessionIdUsed,
        sessionKey: attempt.sessionKey,
        sessionTarget: attempt.sessionTarget,
        sessionFile: attempt.sessionFile,
        messagesSnapshot: transcript.messagesSnapshot,
        prePromptMessageCount: transcript.prePromptMessageCount,
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
            withSessionManagerRewriteLock: transcript.withSessionManagerRewriteLock,
            config: attempt.config,
            agentId: runtime.sessionAgentId,
          }),
        sessionManager: transcript.sessionManager,
        config: attempt.config,
        warn: (message) => log.warn(message),
        isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
      });
    };
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
          sessionFile: attempt.sessionFile,
          promptError: Boolean(state.promptError),
          aborted: lifecycleState.aborted,
          yieldAborted: state.yieldAborted,
          tokenBudget: attempt.contextTokenBudget,
          runtimeContext: afterTurnRuntimeContext,
          contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          providerId: attempt.provider,
          requestedModelId: attempt.requestedModelId,
          modelId: attempt.modelId,
          fallbackReason: attempt.fallbackReason,
          degradedReason: attempt.degradedReason,
          config: attempt.config,
          isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
        });
      }
    } else {
      await finalizeTurn({
        messagesSnapshot: state.messagesSnapshot,
        prePromptMessageCount:
          state.contextEngineAfterTurnCheckpoint ?? state.prePromptMessageCount,
        sessionManager,
        withSessionManagerRewriteLock: input.withOwnedTranscriptWrite,
      });
    }
  }

  if (!state.beforeAgentFinalizeRevisionReason) {
    await input.withOwnedTranscriptWrite(async () => {
      const lifecycleState = input.readLifecycleState();
      if (
        shouldPersistCompletedBootstrapTurn({
          shouldRecordCompletedBootstrapTurn: runtime.shouldRecordCompletedBootstrapTurn,
          promptError: state.promptError,
          aborted: lifecycleState.aborted,
          timedOutDuringCompaction: lifecycleState.timedOutDuringCompaction,
          compactionOccurredThisAttempt: state.compactionOccurredThisAttempt,
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

  const lifecycleAfterTurn = input.readLifecycleState();
  runtime.cacheTrace?.recordStage("session:after", {
    messages: state.messagesSnapshot,
    note: lifecycleAfterTurn.timedOutDuringCompaction
      ? "compaction timeout"
      : state.promptError
        ? "prompt error"
        : undefined,
  });
  runtime.anthropicPayloadLogger?.recordUsage(state.messagesSnapshot, state.promptError);

  if (
    attempt.operation !== "settled-tool-finalization" &&
    !state.beforeAgentFinalizeRevisionReason
  ) {
    const lifecycleForAgentEnd = input.readLifecycleState();
    // Abort outranks failure in terminal-outcome precedence: teardown races can
    // stamp an AbortError into promptError, and surfacing it as `error` would
    // make agent_end consumers treat a user abort as an errored completion.
    const agentEndError =
      state.promptError && !lifecycleForAgentEnd.aborted
        ? formatErrorMessage(state.promptError)
        : undefined;
    runAgentEndSideEffects({
      event: {
        messages: state.messagesSnapshot,
        success: !lifecycleForAgentEnd.aborted && !state.promptError,
        error: agentEndError,
        durationMs: Date.now() - runtime.promptStartedAt,
      },
      ctx: buildEmbeddedAgentEndContext({
        run: attempt,
        agentId: runtime.hookAgentId,
        trace: freezeDiagnosticTraceContext(runtime.diagnosticTrace),
        skillWorkshopAvailable: runtime.skillWorkshopAvailable,
        compacted: state.compactionOccurredThisAttempt,
      }),
      hookRunner: runtime.hookRunner,
    });
  }

  return { sessionIdUsed, sessionFileUsed };
}

/**
 * Releases attempt resources when an embedded-agent run aborts.
 */

type AbortLog = {
  warn(message: string): void;
};

export type EmbeddedAttemptAbortStatePort = {
  markAborted: () => void;
  markExternalAbort: () => void;
  markTimedOut: () => void;
  markTimedOutDuringCompaction: () => void;
  markTimedOutDuringToolExecution: () => void;
  readTimedOutDuringCompaction: () => boolean;
  setPromptError: (error: unknown) => void;
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

function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function createTimeoutAbortReason(): Error {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  return error;
}

/** Owns the external AbortSignal listener and its handoff to the live session. */
export function createEmbeddedAttemptExternalAbortController(input: {
  abortSignal?: AbortSignal;
  cleanupAfterEarlyAbort: () => Promise<void>;
  runAbortController: AbortController;
  runId: string;
  state: EmbeddedAttemptAbortStatePort;
}): {
  arm: () => void;
  dispose: () => void;
  setActiveSessionAbort: (abort: ActiveSessionAbort) => void;
  setCompactionState: (state: {
    isInFlight: () => boolean;
    isPendingOrRetrying: () => boolean;
  }) => void;
  setRunAbort: (abort: RunAbort) => void;
  throwIfFiredAfterPrepCleanup: () => Promise<void>;
} {
  let abortActiveSession: ActiveSessionAbort | undefined;
  let abortRun: RunAbort | undefined;
  let isCompactionPendingOrRetrying: (() => boolean) | undefined;
  let isCompactionInFlight: (() => boolean) | undefined;
  let removeListener: (() => void) | undefined;

  const onAbort = () => {
    const signal = input.abortSignal;
    if (!signal) {
      return;
    }
    input.state.markExternalAbort();
    const reason = getAbortReason(signal);
    const isTimeout = reason ? isSignalTimeoutReason(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout,
        isCompactionPendingOrRetrying: isCompactionPendingOrRetrying?.() ?? false,
        isCompactionInFlight: isCompactionInFlight?.() ?? false,
      })
    ) {
      input.state.markTimedOutDuringCompaction();
    }
    if (abortRun) {
      abortRun(isTimeout, reason);
      return;
    }
    input.state.markAborted();
    if (isTimeout) {
      input.state.markTimedOut();
      if (
        !input.state.readTimedOutDuringCompaction() &&
        countActiveToolExecutions(input.runId) > 0
      ) {
        input.state.markTimedOutDuringToolExecution();
      }
    }
    input.state.setPromptError(createAttemptAbortError(signal));
    if (!input.runAbortController.signal.aborted) {
      input.runAbortController.abort(isTimeout ? (reason ?? createTimeoutAbortReason()) : reason);
    }
    void abortActiveSession?.(input.runAbortController.signal.reason);
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
    throwIfFiredAfterPrepCleanup: async () => {
      const signal = input.abortSignal;
      if (!signal?.aborted) {
        return;
      }
      const abortError = createAttemptAbortError(signal);
      input.state.markAborted();
      input.state.markExternalAbort();
      input.state.setPromptError(abortError);
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
  state: Pick<
    EmbeddedAttemptAbortStatePort,
    | "markAborted"
    | "markTimedOut"
    | "markTimedOutDuringToolExecution"
    | "readTimedOutDuringCompaction"
  >;
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
    input.state.markAborted();
    if (isTimeout) {
      input.state.markTimedOut();
      if (
        !input.state.readTimedOutDuringCompaction() &&
        countActiveToolExecutions(input.attempt.runId) > 0
      ) {
        input.state.markTimedOutDuringToolExecution();
      }
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

/**
 * Flushes attempt trajectory recorders during cleanup.
 */

/** Minimal recorder surface needed to flush trajectory data during run cleanup. */
type EmbeddedAttemptTrajectoryRecorder = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
};

/**
 * Flushes attempt trajectory data through the shared cleanup timeout wrapper so
 * stuck recorder writes warn with run/session context instead of blocking run
 * teardown indefinitely.
 */
export async function flushEmbeddedAttemptTrajectoryRecorder(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: EmbeddedAttemptTrajectoryRecorder | null;
  log: {
    warn: (message: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "openclaw-trajectory-flush",
    log: params.log,
    env: params.env,
    timeoutMs: params.timeoutMs,
    getTimeoutDetails: () => params.trajectoryRecorder?.describeFlushState(),
    cleanup: async () => {
      await params.trajectoryRecorder?.flush();
    },
  });
}

/**
 * Resolves how long aborted attempts wait for cleanup to settle.
 */

type AbortSettleTimeoutEnv = Partial<
  Pick<NodeJS.ProcessEnv, "OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS" | "OPENCLAW_TEST_FAST">
>;

/**
 * Resolves how long embedded-run cleanup waits for abort side effects to settle.
 * The explicit env override is strict decimal milliseconds; invalid values fall
 * back to the normal/test defaults instead of silently widening cleanup waits.
 */
export function resolveEmbeddedAbortSettleTimeoutMs(
  env: AbortSettleTimeoutEnv = process.env,
): number {
  const override = parseStrictPositiveInteger(env.OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS);
  if (override !== undefined) {
    return override;
  }
  return isFastTestRuntimeEnv(env) ? 250 : 2_000;
}
