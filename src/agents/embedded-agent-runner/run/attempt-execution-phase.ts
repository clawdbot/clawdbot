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
import { prepareEmbeddedAttemptHistory } from "./attempt-history.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export async function runEmbeddedAttemptExecutionPhase(
  input: EmbeddedAttemptExecutionPhaseInput & { attempt: EmbeddedRunAttemptInternalParams },
): Promise<EmbeddedRunAttemptResult> {
  const { attempt, state } = input;
  const { sessionRuntime, systemPrompt, toolBase, toolCatalog } = input.prepared;
  const {
    agentSession: {
      activeSession,
      allCustomTools,
      builtinToolNames,
      coreBuiltinToolNames,
      clientToolCallSlots,
      hasDeliveredSourceReply,
      hookRunner,
      markSourceReplyDelivered,
      replaySafeToolNames,
      replaySafeTools,
      codeModeExecToolNames,
      sideEffectToolOwners,
      setActiveSessionSystemPrompt,
      settingsManager,
    },
    anthropicPayloadLogger,
    cacheTrace,
    isOpenAIResponsesApi,
    sessionManager,
    settleTracker: { abortActiveSession, trackPromptSettlePromise },
    state: sessionRuntimeState,
    transcriptPolicy,
    transport: { effectiveAgentTransport, providerTextTransforms },
  } = sessionRuntime;
  const { orphanRepair } = sessionRuntime.boundary;
  const { capabilityToolNames, liveAllowedToolNames, replayAllowedToolNames } =
    toolCatalog.toolSearchRunPlan;
  const { runtimeChannel } = systemPrompt;
  const { nestedToolActivities } = toolBase;
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
  const hookAgentId = input.setup.sessionAgentId;
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
  const { cacheObservabilityEnabled, promptCacheTools } = installEmbeddedAttemptStreamGuards({
    attempt,
    session: activeSession,
    sessionManager,
    sessionAgentId: input.setup.sessionAgentId,
    cacheTrace,
    allCustomTools,
    systemPromptText: sessionRuntimeState.systemPromptText,
    transcriptPolicy,
    isOpenAIResponsesApi,
    replayAllowedToolNames,
    liveAllowedToolNames,
    anthropicPayloadLogger,
    codeModeExecToolNames,
    effectiveAgentTransport,
    providerTextTransforms,
    runTrace: input.diagnostics.runTrace,
    isYieldDetected: () => input.lifecycle.readYieldState().yieldDetected,
    onRejectedProviderReplayRepaired: () => {
      repairedRejectedProviderReplay = true;
    },
    onIdleTimeout: (error) => idleTimeoutTriggerRef.current?.(error),
    abortSignal: input.runAbortController.signal,
    diagnosticOwner,
  });
  input.setup.prepStages.mark("stream-setup");
  input.setup.emitPrepStageSummary("stream-ready");

  let preparedHistory: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
  try {
    preparedHistory = await prepareEmbeddedAttemptHistory({
      attempt,
      activeSession,
      sessionManager,
      ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
      cacheTrace,
      capabilityToolNames,
      compactionReplayEnabled: sessionRuntime.transport.compactionReplayEnabled,
      effectiveWorkspace: input.setup.effectiveWorkspace,
      isOpenAIResponsesApi,
      isRawModelRun: input.isRawModelRun,
      ...(orphanRepair ? { orphanRepair } : {}),
      replayAllowedToolNames,
      sandboxed: input.setup.sandbox?.enabled === true,
      sessionAgentId: input.setup.sessionAgentId,
      settingsManager,
      systemPromptText: sessionRuntimeState.systemPromptText,
      transcriptPolicy,
      setActiveSessionSystemPrompt,
    });
  } catch (error) {
    await flushPendingToolResultsAfterIdle({
      agent: activeSession.agent,
      sessionManager,
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
    state: input.abortState,
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
    runtimeChannel,
    hookRunner,
    hookAgentId,
    diagnosticTrace: input.diagnostics.diagnosticTrace,
    clientToolCallSlots,
    nestedToolActivities,
    isReplaySafeTool: (tool) => replaySafeTools.has(tool as never),
    hasDeliveredSourceReply,
    markSourceReplyDelivered,
    sandboxSessionKey: input.setup.sandboxSessionKey,
    builtinToolNames,
    coreBuiltinToolNames,
    replaySafeToolNames,
    codeModeExecToolNames,
    sideEffectToolOwners,
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
      observabilityEnabled: cacheObservabilityEnabled,
      promptTools: promptCacheTools,
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
