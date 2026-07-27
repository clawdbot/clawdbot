import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  runAgentHarnessLlmOutputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
  nativeSessionHistoryUnvalidated: boolean;
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
    nativeSessionHistoryUnvalidated,
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
  const recorder = input.userTurnTranscriptRecorder;
  const currentRunUserKey = `${input.runId}:user`;
  const messagesSnapshot =
    transcript?.messagesSnapshot ??
    (recorder?.isBlocked()
      ? removePreparedUser(messages, recorder.message, currentRunUserKey)
      : includePreparedUser(
          messages,
          recorder?.message,
          input.trigger === "memory",
          currentRunUserKey,
        ));
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
    journalValidated:
      transcript !== undefined &&
      !aborted &&
      !timedOut &&
      promptError === undefined &&
      !nativeSessionHistoryUnvalidated &&
      transcriptJournal?.hasFailed() !== true &&
      !transcript?.replayInvalid &&
      (!sentTurnStarted || settledToolFinalization || transcript.initialSdkUserValidated),
    messagesSnapshot,
    assistantTranscriptOwned: transcript?.assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey: transcript?.assistantTranscriptIdempotencyKey,
    nativeReplayInvalid: transcript?.replayInvalid === true || nativeSessionHistoryUnvalidated,
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

function includePreparedUser(
  messages: AgentMessage[],
  prepared: Extract<AgentMessage, { role: "user" }> | undefined,
  hidden: boolean,
  currentRunUserKey: string,
): AgentMessage[] {
  if (!prepared) {
    return messages;
  }
  const projected = projectAgentHarnessTranscriptMessageForDisplay({
    hidden: hidden || (prepared as { display?: boolean }).display === false,
    message: prepared,
  }) as Extract<AgentMessage, { role: "user" }>;
  const tail = messages.at(-1);
  if (isSamePreparedUser(tail, projected, currentRunUserKey)) {
    return [...messages.slice(0, -1), projected];
  }
  return [...messages, projected];
}

function removePreparedUser(
  messages: AgentMessage[],
  prepared: Extract<AgentMessage, { role: "user" }> | undefined,
  currentRunUserKey: string,
): AgentMessage[] {
  return prepared && isSamePreparedUser(messages.at(-1), prepared, currentRunUserKey)
    ? messages.slice(0, -1)
    : messages;
}

function isSamePreparedUser(
  candidate: AgentMessage | undefined,
  prepared: Extract<AgentMessage, { role: "user" }>,
  currentRunUserKey: string,
): boolean {
  if (candidate?.role !== "user") {
    return false;
  }
  if (candidate === prepared) {
    return true;
  }
  const candidateKey = (candidate as { idempotencyKey?: unknown }).idempotencyKey;
  const preparedKey = (prepared as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof candidateKey === "string" || typeof preparedKey === "string") {
    if (typeof candidateKey === "string" && typeof preparedKey === "string") {
      return candidateKey === preparedKey;
    }
    if (
      typeof candidateKey !== "string" ||
      typeof preparedKey === "string" ||
      (!candidateKey.startsWith("copilot:") && candidateKey !== currentRunUserKey)
    ) {
      return false;
    }
  }
  return (
    candidate.timestamp === prepared.timestamp &&
    userText(candidate.content) === userText(prepared.content)
  );
}

function userText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length === 1) {
    const part = content[0] as { text?: unknown; type?: unknown };
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return JSON.stringify(content) ?? "";
}
