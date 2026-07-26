import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  runAgentHarnessLlmOutputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { finalizeCopilotAttempt } from "./attempt-cleanup.js";
import { createResult, hasMirrorIdentity, readString, readTailUserText } from "./attempt-config.js";
import { withPromptFailure } from "./attempt-types.js";
import type {
  AgentHarnessAttemptResult,
  AttemptParamsLike,
  CopilotAgentEndHookParams,
  ModelRef,
} from "./attempt-types.js";
import {
  attachCopilotMirrorIdentity,
  dualWriteCopilotTranscriptBestEffort,
} from "./dual-write-transcripts.js";
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
  const syntheticUserText = readString(input.transcriptPrompt) ?? readString(input.prompt);
  const tailUserText = readTailUserText(messages);
  const tailUserIndex = messages.findLastIndex((message) => message.role === "user");
  const currentTurnMessages = messages.map((message, index) => {
    if (syntheticUserText !== tailUserText || index !== tailUserIndex) {
      return message;
    }
    return projectAgentHarnessTranscriptMessageForDisplay({
      hidden: input.trigger === "memory",
      message: attachCopilotMirrorIdentity(
        { ...message, idempotencyKey: `${input.runId}:user` } as unknown as AgentMessage,
        `${input.runId}:prompt`,
      ),
    });
  });
  const syntheticUser: AgentMessage | undefined =
    syntheticUserText && syntheticUserText !== tailUserText
      ? projectAgentHarnessTranscriptMessageForDisplay({
          hidden: input.trigger === "memory",
          message: attachCopilotMirrorIdentity(
            {
              role: "user",
              content: syntheticUserText,
              timestamp: now(),
              idempotencyKey: `${input.runId}:user`,
            } as unknown as AgentMessage,
            `${input.runId}:prompt`,
          ),
        })
      : undefined;
  const taggedLastAssistant = lastAssistant
    ? projectAgentHarnessTranscriptMessageForDisplay({
        hidden: input.trigger === "memory",
        message: attachCopilotMirrorIdentity(lastAssistant, `${input.runId}:assistant:final`),
      })
    : undefined;
  const messagesSnapshot: AgentMessage[] = [
    ...currentTurnMessages,
    ...(syntheticUser ? [syntheticUser] : []),
    ...(taggedLastAssistant ? [taggedLastAssistant] : []),
  ];
  const openClawSessionIdForMirror = readString(input.sessionId);
  const sessionKeyForMirror = readString((input as { sessionKey?: unknown }).sessionKey);
  const openClawStorePathForMirror = readString(input.sessionTarget?.storePath);
  const mirrorScopeSessionId = sessionIdUsed ?? openClawSessionIdForMirror;
  if (
    openClawSessionIdForMirror &&
    sessionKeyForMirror &&
    openClawStorePathForMirror &&
    messagesSnapshot.length > 0
  ) {
    const taggedMessages = messagesSnapshot.map((message, index) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult"
      ) {
        return message;
      }
      if (hasMirrorIdentity(message)) {
        return message;
      }
      const identityScope = sdkSessionId ?? mirrorScopeSessionId ?? "attempt";
      return attachCopilotMirrorIdentity(message, `${identityScope}:${message.role}:${index}`);
    });
    await dualWriteCopilotTranscriptBestEffort({
      sessionId: openClawSessionIdForMirror,
      sessionKey: sessionKeyForMirror,
      agentId: readString(input.agentId),
      storePath: openClawStorePathForMirror,
      messages: taggedMessages,
      idempotencyScope: mirrorScopeSessionId ? `copilot:${mirrorScopeSessionId}` : undefined,
      config: (input as { config?: unknown }).config as never,
    }).catch((mirrorError: unknown) => {
      console.warn(
        "[copilot-attempt] dual-write transcript wrapper rejected unexpectedly",
        mirrorError,
      );
    });
  }
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
  if (sentTurnStarted && !settledToolFinalization) {
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
