import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { runAgentHarnessLlmOutputHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import { finalizeCopilotAttempt } from "./attempt-cleanup.js";
import { createResult } from "./attempt-config.js";
import type { AttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import { withPromptFailure } from "./attempt-types.js";
import type {
  AgentHarnessAttemptResult,
  AttemptParamsLike,
  CopilotAgentEndHookParams,
  ModelRef,
} from "./attempt-types.js";
import { attachEventBridge } from "./event-bridge.js";
export async function completeCopilotAttempt(params: {
  aborted: boolean;
  attemptStartedAt: number;
  bridge: ReturnType<typeof attachEventBridge> | undefined;
  downgradedFromResume: boolean;
  externalAbort: boolean;
  hookContext: CopilotAgentEndHookParams["ctx"];
  hookContextWindowFields: {
    contextTokenBudget?: number;
    contextWindowReferenceTokens?: number;
    contextWindowSource?: NonNullable<AttemptParamsLike["contextWindowInfo"]>["source"];
  };
  input: AttemptParamsLike;
  lastToolError: AgentHarnessAttemptResult["lastToolError"];
  messages: AgentMessage[];
  transcriptJournal: AttemptTranscriptJournal | undefined;
  modelRef: ModelRef;
  now: () => number;
  promptError: Error | undefined;
  releaseError: Error | undefined;
  resumeFailureRecovered: boolean;
  sdkSessionId: string | undefined;
  sentTurnStarted: boolean;
  sessionIdUsed: string | undefined;
  settledFinalizationAssistantCompleted: boolean;
  settledToolFinalization: boolean;
  timedOut: boolean;
  timedOutDuringCompaction: boolean;
  yieldDetected: boolean;
}): Promise<AgentHarnessAttemptResult> {
  const {
    aborted,
    attemptStartedAt,
    bridge,
    downgradedFromResume,
    externalAbort,
    hookContext,
    hookContextWindowFields,
    input,
    lastToolError,
    messages,
    transcriptJournal,
    modelRef,
    now,
    promptError,
    releaseError,
    resumeFailureRecovered,
    sdkSessionId,
    sentTurnStarted,
    sessionIdUsed,
    settledFinalizationAssistantCompleted,
    settledToolFinalization,
    timedOut,
    timedOutDuringCompaction,
    yieldDetected,
  } = params;
  const snap = bridge?.snapshot();
  const assistantTexts = bridge?.finalizeAssistantTexts() ?? [];
  const lastAssistant = bridge?.buildAssistantMessage({ modelRef, now });
  const transcript = transcriptJournal?.snapshot();
  // Pre-journal failures keep the prepared input snapshot. Reconstructing a
  // user/assistant mirror here would restore the deleted dual-write owner.
  const messagesSnapshot = transcript?.messagesSnapshot ?? messages;
  const result = createResult(input, {
    aborted,
    assistantTexts,
    currentAttemptAssistant: lastAssistant,
    currentAttemptCompletedAssistant: settledFinalizationAssistantCompleted
      ? lastAssistant
      : undefined,
    downgradedFromResume,
    externalAbort,
    itemLifecycle: {
      activeCount: Math.max((snap?.startedCount ?? 0) - (snap?.completedCount ?? 0), 0),
      completedCount: snap?.completedCount ?? 0,
      startedCount: snap?.startedCount ?? 0,
    },
    lastAssistant,
    lastToolError,
    messagesSnapshot,
    assistantTranscriptOwned: transcript?.assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey: transcript?.assistantTranscriptIdempotencyKey,
    nativeReplayInvalid: transcript?.replayInvalid,
    now,
    promptError,
    resumeFailureRecovered,
    sdkSessionId,
    sessionIdUsed,
    timedOut,
    timedOutDuringCompaction,
    toolMetas: snap ? [...snap.toolMetas] : [],
    usage: snap?.usage,
    yieldDetected,
  });
  if (sentTurnStarted && !settledToolFinalization && !transcriptJournal?.hasFailed()) {
    runAgentHarnessLlmOutputHook({
      event: {
        runId: input.runId,
        sessionId: input.sessionId,
        provider: modelRef.provider,
        model: modelRef.id,
        ...hookContextWindowFields,
        resolvedRef:
          input.runtimePlan?.observability.resolvedRef ?? `${modelRef.provider}/${modelRef.id}`,
        ...(input.runtimePlan?.observability.harnessId
          ? { harnessId: input.runtimePlan.observability.harnessId }
          : {}),
        assistantTexts: result.assistantTexts,
        ...(result.lastAssistant ? { lastAssistant: result.lastAssistant } : {}),
        ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      },
      ctx: hookContext,
    });
  }
  if (releaseError) {
    if (!settledToolFinalization) {
      await finalizeCopilotAttempt(
        input,
        {
          ...result,
          terminal: withPromptFailure(result.terminal, releaseError),
        },
        hookContext,
        attemptStartedAt,
        now,
      );
    }
    throw releaseError;
  }
  return settledToolFinalization
    ? result
    : finalizeCopilotAttempt(input, result, hookContext, attemptStartedAt, now);
}
