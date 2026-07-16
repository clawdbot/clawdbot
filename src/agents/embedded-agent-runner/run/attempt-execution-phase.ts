/** Prepares the guarded stream runtime before prompt execution and settlement. */
import { runEmbeddedAttemptSettledPhase } from "./attempt-execution-settle.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { prepareEmbeddedAttemptStreamRuntime } from "./attempt-stream-runtime-prepare.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export async function runEmbeddedAttemptExecutionPhase(
  input: EmbeddedAttemptExecutionPhaseInput,
): Promise<EmbeddedRunAttemptResult> {
  const { attempt, state } = input;
  const { sessionRuntime, systemPrompt, toolBase, toolCatalog } = input.prepared;
  const {
    agentSession: {
      activeSession,
      allCustomTools,
      builtinToolNames,
      clientToolCallSlots,
      clientToolLoopDetection,
      hasDeliveredSourceReply,
      hookRunner,
      markSourceReplyDelivered,
      replaySafeToolNames,
      replaySafeTools,
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
  const { toolSearchTargetTranscriptProjections } = toolBase;
  const hookAgentId = input.setup.sessionAgentId;
  let repairedRejectedThinkingReplay = false;

  const preparedStreamRuntime = await prepareEmbeddedAttemptStreamRuntime({
    attempt,
    activeSession,
    sessionManager,
    sessionLockController: input.sessionLock.sessionLockController,
    ownedTranscriptWriteContext: input.sessionLock.ownedTranscriptWriteContext,
    runAbortController: input.runAbortController,
    externalAbortController: input.externalAbortController,
    abortActiveSession,
    abortState: input.abortState,
    trackPromptSettlePromise,
    compactionTimeoutMs: input.sessionLock.compactionTimeoutMs,
    guards: {
      sessionAgentId: input.setup.sessionAgentId,
      cacheTrace,
      allCustomTools,
      systemPromptText: sessionRuntimeState.systemPromptText,
      transcriptPolicy,
      isOpenAIResponsesApi,
      replayAllowedToolNames,
      liveAllowedToolNames,
      clientToolLoopDetection,
      anthropicPayloadLogger,
      effectiveAgentTransport,
      providerTextTransforms,
      runTrace: input.diagnostics.runTrace,
    },
    history: {
      ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
      cacheTrace,
      capabilityToolNames,
      effectiveWorkspace: input.setup.effectiveWorkspace,
      isOpenAIResponsesApi,
      isRawModelRun: input.isRawModelRun,
      ...(orphanRepair ? { orphanRepair } : {}),
      replayAllowedToolNames,
      sessionAgentId: input.setup.sessionAgentId,
      settingsManager,
      systemPromptText: sessionRuntimeState.systemPromptText,
      transcriptPolicy,
      setActiveSessionSystemPrompt,
    },
    stream: {
      runtimeChannel,
      hookRunner,
      hookAgentId,
      diagnosticTrace: input.diagnostics.diagnosticTrace,
      clientToolCallSlots,
      toolSearchTargetTranscriptProjections,
      isReplaySafeTool: (tool) => replaySafeTools.has(tool as never),
      hasDeliveredSourceReply,
      markSourceReplyDelivered,
      sandboxSessionKey: input.setup.sandboxSessionKey,
      builtinToolNames,
      replaySafeToolNames,
    },
    lifecycle: {
      isYieldDetected: () => input.lifecycle.readYieldState().yieldDetected,
      markRejectedThinkingReplayRepaired: () => {
        repairedRejectedThinkingReplay = true;
      },
      markStreamReady: () => {
        input.setup.prepStages.mark("stream-setup");
        input.setup.emitPrepStageSummary("stream-ready");
      },
      markIdleTimedOut: () => {
        state.idleTimedOut = true;
      },
      markExternalAbort: () => {
        state.externalAbort = true;
      },
      markTimedOutDuringCompaction: () => {
        state.timedOutDuringCompaction = true;
      },
      markTimedOutByRunBudget: () => {
        state.timedOutByRunBudget = true;
      },
      readRunState: () => ({
        aborted: state.aborted,
        promptError: state.promptError,
        timedOut: state.timedOut,
        yieldDetected: input.lifecycle.readYieldState().yieldDetected,
      }),
      setToolSearchCatalogExecutor: input.lifecycle.setToolSearchCatalogExecutor,
    },
  });
  return await runEmbeddedAttemptSettledPhase({
    ...input,
    preparedStreamRuntime,
    getRepairedRejectedThinkingReplay: () => repairedRejectedThinkingReplay,
  });
}
