/** Prepares the guarded stream runtime before prompt execution and settlement. */
import {
  bindOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  type AgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { agentSessionSetContextReplacementHook } from "../../sessions/agent-session-compaction.js";
import { log } from "../logger.js";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { createEmbeddedAttemptRunAbort } from "./attempt-finalize.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export async function runEmbeddedAttemptExecutionPhase(
  input: EmbeddedAttemptExecutionPhaseInput,
): Promise<EmbeddedRunAttemptResult> {
  const { attempt, state } = input;
  const { sessionRuntime, systemPrompt, toolBase } = input.prepared;
  const {
    agentSession: { activeSession, replaySafeTools },
    settleTracker: { abortActiveSession, trackPromptSettlePromise },
  } = sessionRuntime;
  // Preparation can retire admission; never install an unfenced memory compactor.
  const assertActive = resolveAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    input.runAbortController.signal,
  );
  if (!assertActive) {
    input.runAbortController.signal.throwIfAborted();
    throw new Error("embedded attempt requires an active admitted run");
  }
  activeSession[agentSessionSetContextReplacementHook]((tokensAfter) => {
    toolBase.skillInstructionDeliveryCache.clear();
    attempt.onContextAccountingEvent?.({ kind: "compaction", tokensAfter });
  }, assertActive);
  let repairedRejectedProviderReplay = false;
  const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    runId: attempt.runId,
  });
  const mergeTerminal = (incoming: AgentRunAttemptTerminal) => {
    state.terminal = mergeAgentRunAttemptTerminal(state.terminal, incoming);
  };

  const idleTimeoutTriggerRef: { current?: (error: Error) => void } = {};
  const { onModelRequest, onModelUsage, getPromptCacheObservation } =
    installEmbeddedAttemptStreamGuards(input, {
      onRejectedProviderReplayRepaired: () => {
        repairedRejectedProviderReplay = true;
      },
      onIdleTimeout: (error) => idleTimeoutTriggerRef.current?.(error),
      diagnosticOwner,
    });
  input.setup.prepStages.mark("stream-setup");
  input.setup.emitPrepStageSummary("stream-ready");

  let preparedHistory: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
  try {
    preparedHistory = await prepareEmbeddedAttemptHistory(input);
  } catch (error) {
    await flushPendingToolResultsAfterIdle({
      agent: activeSession.agent,
      sessionManager: sessionRuntime.sessionManager,
      // An already-aborted setup must dispose immediately without orphaning tool calls.
      ...(attempt.abortSignal?.aborted ? { timeoutMs: 0 } : {}),
    });
    activeSession.dispose();
    throw error;
  }

  const isProbeSession = attempt.sessionId?.startsWith("probe-") ?? false;
  const queueHandleRef: { current?: EmbeddedAgentQueueHandle } = {};
  const abortRun = createEmbeddedAttemptRunAbort({
    abortActiveSession,
    activeSession,
    attempt,
    getQueueHandle: () => queueHandleRef.current,
    isProbeSession,
    log,
    runAbortController: input.runAbortController,
    state: input.state,
  });
  input.externalAbortController.setRunAbort(abortRun);
  idleTimeoutTriggerRef.current = (error) => {
    // Caller cancellation owns the terminal outcome when it beats a late watchdog callback.
    if (input.runAbortController.signal.aborted) {
      return;
    }
    mergeTerminal({
      kind: "timeout",
      phase: activeSession.isCompacting ? "compaction" : "prompt",
      source: "idle",
    });
    abortRun(true, error);
  };
  const abortable = <T>(promise: Promise<T>): Promise<T> =>
    abortableWithSignal(input.runAbortController.signal, promise);
  const promptActiveSession = (
    prompt: string,
    options?: Parameters<typeof activeSession.prompt>[1],
  ): Promise<void> =>
    withOwnedSessionTranscriptWrites(input.sessionLock.ownedTranscriptWriteContext, async () => {
      // Prompting starts its own agent loop; reject before creating a loop that
      // an already-aborted attempt can no longer cancel.
      if (input.runAbortController.signal.aborted) {
        return abortable(Promise.resolve());
      }
      return abortable(trackPromptSettlePromise(activeSession.prompt(prompt, options)));
    });
  const onBlockReply = attempt.onBlockReply
    ? bindOwnedSessionTranscriptWrites(
        input.sessionLock.ownedTranscriptWriteContext,
        attempt.onBlockReply,
      )
    : undefined;
  const onBlockReplyFlush = attempt.onBlockReplyFlush
    ? bindOwnedSessionTranscriptWrites(
        input.sessionLock.ownedTranscriptWriteContext,
        attempt.onBlockReplyFlush,
      )
    : undefined;
  const preparedStream = prepareEmbeddedAttemptStream({
    attempt,
    onModelUsage,
    applyPermissionMode: input.lifecycle.applyPermissionMode,
    activeSession,
    runAbortController: input.runAbortController,
    abortRun,
    markExternalAbort: () => mergeTerminal({ kind: "aborted", source: "external" }),
    getRunState: () => {
      const terminal = projectAgentRunAttemptTerminal(state.terminal);
      return {
        aborted: terminal.aborted,
        promptError: terminal.promptError,
        timedOut: terminal.timedOut,
        yieldDetected: input.lifecycle.readYieldState().yieldDetected,
      };
    },
    onBlockReply,
    onBlockReplyFlush,
    runtimeChannel: systemPrompt.runtimeChannel,
    hookRunner: sessionRuntime.agentSession.hookRunner,
    hookAgentId: input.setup.sessionAgentId,
    diagnosticTrace: input.diagnostics.diagnosticTrace,
    clientToolCallSlots: sessionRuntime.agentSession.clientToolCallSlots,
    nestedToolActivities: toolBase.nestedToolActivities,
    isReplaySafeTool: (tool) => replaySafeTools.has(tool as never),
    hasDeliveredSourceReply: sessionRuntime.agentSession.hasDeliveredSourceReply,
    markSourceReplyDelivered: sessionRuntime.agentSession.markSourceReplyDelivered,
    sandboxSessionKey: input.setup.sandboxSessionKey,
    builtinToolNames: sessionRuntime.agentSession.builtinToolNames,
    coreBuiltinToolNames: sessionRuntime.agentSession.coreBuiltinToolNames,
    replaySafeToolNames: sessionRuntime.agentSession.replaySafeToolNames,
    codeModeExecToolNames: sessionRuntime.agentSession.codeModeExecToolNames,
    sideEffectToolOwners: sessionRuntime.agentSession.sideEffectToolOwners,
    diagnosticOwner,
    trajectoryRecorder: sessionRuntime.trajectoryRecorder,
  });
  state.deferredLifecycleOwner = preparedStream.deferredLifecycleOwner;
  input.lifecycle.setToolSearchCatalogExecutor(preparedStream.toolSearchCatalogExecutor);
  input.externalAbortController.setCompactionState({
    isPendingOrRetrying: preparedStream.subscription.isCompacting,
    isInFlight: () => activeSession.isCompacting,
  });
  queueHandleRef.current = preparedStream.queueHandle;

  const attemptTimeout = prepareEmbeddedAttemptTimeout({
    attempt,
    activeSession,
    runAbortSignal: input.runAbortController.signal,
    compactionState: preparedStream.subscription,
    compactionTimeoutMs: input.sessionLock.compactionTimeoutMs,
    isProbeSession,
    abortRun,
    markTimedOutDuringCompaction: () =>
      mergeTerminal({ kind: "timeout", phase: "compaction", source: "observation" }),
    markTimedOutByRunBudget: () =>
      mergeTerminal({ kind: "timeout", phase: "prompt", source: "run_budget" }),
  });

  const preparedStreamRuntime = {
    abortable,
    cache: {
      onModelRequest,
      getObservation: getPromptCacheObservation,
    },
    history: preparedHistory,
    isProbeSession,
    onBlockReplyFlush,
    promptActiveSession,
    stream: preparedStream,
    timeout: attemptTimeout,
  };
  return await runEmbeddedAttemptSettledPhase({
    ...input,
    preparedStreamRuntime,
    getRepairedRejectedProviderReplay: () => repairedRejectedProviderReplay,
  });
}
