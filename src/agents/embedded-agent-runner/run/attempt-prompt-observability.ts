/** Records the fully assembled prompt boundary before preflight and submission. */
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  type DiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import type { PluginHookLlmInputEvent } from "../../../plugins/hook-types.js";
import type { HookRunner } from "../../../plugins/hooks.js";
import {
  type createTrajectoryRuntimeRecorder,
  toTrajectoryToolDefinitions,
} from "../../../trajectory/runtime.js";
import type { createCacheTrace } from "../../cache-trace.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import { log } from "../logger.js";
import { summarizeSessionContext } from "./attempt-context-summary.js";
import { cloneHookMessages } from "./attempt-hook-messages.js";
import { resolvePromptSubmissionSkipReason } from "./attempt-prompt-skip.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptPromptObservabilityParams = Pick<
  EmbeddedRunAttemptParams,
  | "channelContext"
  | "chatId"
  | "currentChannelId"
  | "messageChannel"
  | "messageProvider"
  | "messageTo"
  | "modelId"
  | "onExecutionPhase"
  | "provider"
  | "runId"
  | "senderId"
  | "sessionFile"
  | "sessionId"
  | "sessionKey"
  | "trigger"
  | "workspaceDir"
>;
type CacheTrace = Pick<NonNullable<ReturnType<typeof createCacheTrace>>, "recordStage"> | null;
type PromptHookRunner = Pick<HookRunner, "hasHooks" | "runLlmInput"> | null;
type TrajectoryRecorder = Pick<
  NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>,
  "recordEvent"
> | null;
type TrajectoryTool = Parameters<typeof toTrajectoryToolDefinitions>[0][number];

export function observeEmbeddedAttemptPrompt(input: {
  attempt: AttemptPromptObservabilityParams;
  cacheTrace: CacheTrace;
  contextTokenBudget: number;
  diagnosticTrace: DiagnosticTraceContext;
  effectivePrompt: string;
  effectiveTools: readonly TrajectoryTool[];
  hookAgentId: string;
  hookMessagesForCurrentPrompt: AgentMessage[];
  hookRunner: PromptHookRunner;
  imageCount: number;
  isRawModelRun: boolean;
  llmBoundaryPromptForPrecheck: string;
  promptForModel: string;
  promptSubmissionRuntimeOnly?: boolean;
  reserveTokens: number;
  runTrace: DiagnosticTraceContext;
  sessionMessages: AgentMessage[];
  skipPromptSubmission: boolean;
  streamStrategy: string;
  systemPromptForHook: string;
  systemPromptText?: string;
  toolSearchCompacted: boolean;
  tools: PluginHookLlmInputEvent["tools"];
  trajectoryRecorder: TrajectoryRecorder;
  transcriptLeafId: string | null;
  transport: AgentSession["agent"]["transport"];
  uncompactedEffectiveTools: readonly TrajectoryTool[];
}): { skipPromptSubmission: boolean } {
  const { attempt } = input;
  let skipPromptSubmission = input.skipPromptSubmission;

  if (!skipPromptSubmission) {
    input.cacheTrace?.recordStage("prompt:before", {
      prompt: input.promptForModel,
      messages: input.sessionMessages,
    });
    input.cacheTrace?.recordStage("prompt:images", {
      prompt: input.promptForModel,
      messages: input.sessionMessages,
      note: `images: prompt=${input.imageCount}`,
    });
    const providerVisibleTools = toTrajectoryToolDefinitions(input.effectiveTools);
    input.trajectoryRecorder?.recordEvent("context.compiled", {
      systemPrompt: input.systemPromptForHook,
      prompt: input.promptForModel,
      messages: input.sessionMessages,
      tools: toTrajectoryToolDefinitions(
        input.toolSearchCompacted ? input.uncompactedEffectiveTools : input.effectiveTools,
      ),
      ...(input.toolSearchCompacted ? { providerVisibleTools } : {}),
      imagesCount: input.imageCount,
      streamStrategy: input.streamStrategy,
      transport: input.transport,
      transcriptLeafId: input.transcriptLeafId,
    });
  }

  const promptSkipReason = skipPromptSubmission
    ? null
    : resolvePromptSubmissionSkipReason({
        prompt: input.promptForModel,
        messages: input.sessionMessages,
        runtimeOnly: input.promptSubmissionRuntimeOnly,
        imageCount: input.imageCount,
      });
  if (promptSkipReason) {
    skipPromptSubmission = true;
    const skipContext =
      `runId=${attempt.runId} sessionId=${attempt.sessionId} trigger=${attempt.trigger} ` +
      `provider=${attempt.provider}/${attempt.modelId}`;
    if (promptSkipReason === "blank_user_prompt") {
      log.warn(`embedded run prompt skipped: blank user prompt ${skipContext}`);
    } else {
      log.info(`embedded run prompt skipped: empty prompt/history/images ${skipContext}`);
    }
    input.trajectoryRecorder?.recordEvent("prompt.skipped", {
      reason: promptSkipReason,
      prompt: input.promptForModel,
      messages: input.sessionMessages,
      imagesCount: input.imageCount,
    });
  }

  const sessionSummary = summarizeSessionContext(input.sessionMessages);
  emitTrustedDiagnosticEvent({
    type: "context.assembled",
    runId: attempt.runId,
    ...(attempt.sessionKey && { sessionKey: attempt.sessionKey }),
    ...(attempt.sessionId && { sessionId: attempt.sessionId }),
    provider: attempt.provider,
    model: attempt.modelId,
    ...((attempt.messageChannel ?? attempt.messageProvider)
      ? { channel: attempt.messageChannel ?? attempt.messageProvider }
      : {}),
    trigger: attempt.trigger,
    messageCount: input.sessionMessages.length,
    historyTextChars: sessionSummary.totalTextChars,
    historyImageBlocks: sessionSummary.totalImageBlocks,
    maxMessageTextChars: sessionSummary.maxMessageTextChars,
    systemPromptChars: input.systemPromptText?.length ?? 0,
    promptChars: input.effectivePrompt.length,
    promptImages: input.imageCount,
    contextTokenBudget: input.contextTokenBudget,
    reserveTokens: input.reserveTokens,
    trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(input.runTrace)),
  });
  attempt.onExecutionPhase?.({
    phase: "context_assembled",
    provider: attempt.provider,
    model: attempt.modelId,
  });

  if (log.isEnabled("debug")) {
    log.debug(
      `[context-diag] pre-prompt: sessionKey=${attempt.sessionKey ?? attempt.sessionId} ` +
        `messages=${input.sessionMessages.length} roleCounts=${sessionSummary.roleCounts} ` +
        `historyTextChars=${sessionSummary.totalTextChars} ` +
        `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
        `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
        `systemPromptChars=${input.systemPromptText?.length ?? 0} ` +
        `promptChars=${input.effectivePrompt.length} ` +
        `promptImages=${input.imageCount} ` +
        `provider=${attempt.provider}/${attempt.modelId} sessionFile=${attempt.sessionFile}`,
    );
  }

  if (!skipPromptSubmission && !input.isRawModelRun && input.hookRunner?.hasHooks("llm_input")) {
    void input.hookRunner
      .runLlmInput(
        {
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          systemPrompt: input.systemPromptForHook,
          prompt: input.llmBoundaryPromptForPrecheck,
          historyMessages: cloneHookMessages(input.hookMessagesForCurrentPrompt),
          imagesCount: input.imageCount,
          tools: input.tools,
        },
        {
          runId: attempt.runId,
          trace: freezeDiagnosticTraceContext(input.diagnosticTrace),
          agentId: input.hookAgentId,
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          workspaceDir: attempt.workspaceDir,
          trigger: attempt.trigger,
          ...buildAgentHookContextChannelFields(attempt),
          ...buildAgentHookContextIdentityFields({
            trigger: attempt.trigger,
            senderId: attempt.senderId,
            chatId: attempt.chatId,
            channelContext: attempt.channelContext,
          }),
        },
      )
      .catch((err: unknown) => {
        log.warn(`llm_input hook failed: ${String(err)}`);
      });
  }

  return { skipPromptSubmission };
}
