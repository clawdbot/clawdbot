/**
 * Supports prompt construction and observation between session setup and submission.
 * It may assume resolved tools, hook context, and diagnostic inputs are ready.
 */
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
import { getPluginToolMeta } from "../../../plugins/tools.js";
import {
  type createTrajectoryRuntimeRecorder,
  toTrajectoryToolDefinitions,
} from "../../../trajectory/runtime.js";
import type { createCacheTrace } from "../../cache-trace.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from "../../code-mode-control-tools.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../../tool-search-types.js";
import {
  restrictToolSearchCatalog,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
} from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { log } from "../logger.js";
import { summarizeSessionContext } from "./attempt-context-summary.js";
import { resolvePromptSubmissionSkipReason } from "./attempt-prompt-submit.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
} from "./attempt-tool-construction-plan.js";
import type { ResolvedToolPromptFinalizer } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type NamedTool = { name: string };
type PromptToolSession = Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName">;

type PromptBuildToolPolicyBaseline = {
  activeToolNames: readonly string[];
  catalogEntries: readonly ToolSearchCatalogEntry[];
};

function readNamedToolPluginMeta(tool: NamedTool): { pluginId: string } | undefined {
  if (!("execute" in tool) || typeof tool.execute !== "function") {
    return undefined;
  }
  return getPluginToolMeta(tool as AnyAgentTool);
}

export function applyResolvedToolPromptFinalizer(params: {
  prompt: string;
  activeToolNames: readonly string[];
  finalize?: ResolvedToolPromptFinalizer;
}): string {
  if (!params.finalize) {
    return params.prompt;
  }
  return params.finalize({
    prompt: params.prompt,
    messageToolAvailable: params.activeToolNames.some(
      (toolName) => normalizeToolPolicyName(toolName) === "message",
    ),
  });
}

function filterTools<T extends NamedTool>(
  tools: readonly T[],
  toolsAllow: string[],
  toolMeta: (tool: T) => { pluginId: string } | undefined = readNamedToolPluginMeta,
): T[] {
  return applyEmbeddedAttemptToolsAllow([...tools], toolsAllow, {
    toolMeta,
  });
}

function applyToolsAllow<T extends NamedTool>(
  tools: readonly T[],
  toolsAllow: string[] | undefined,
  toolMeta?: (tool: T) => { pluginId: string } | undefined,
): T[] {
  return toolsAllow === undefined ? [...tools] : filterTools(tools, toolsAllow, toolMeta);
}

function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Applies a prompt-hook tool cap to the already-built turn surface. Filtering
 * the concrete host baseline makes the hook an intersection with every host
 * policy while allowing a later prompt build to apply a different cap.
 */
export function applyPromptBuildToolsAllow<
  TEffectiveTool extends NamedTool,
  TUncompactedTool extends NamedTool,
  TTool extends NamedTool,
>(params: {
  session: PromptToolSession;
  toolsAllow?: string[];
  baseline: PromptBuildToolPolicyBaseline;
  effectiveTools: TEffectiveTool[];
  uncompactedEffectiveTools: TUncompactedTool[];
  tools: TTool[];
  catalogRef?: ToolSearchCatalogRef;
  codeModeControlsEnabled: boolean;
  forceToolNames?: readonly string[];
}): {
  activeToolNames: string[];
  effectiveTools: TEffectiveTool[];
  uncompactedEffectiveTools: TUncompactedTool[];
  tools: TTool[];
} {
  const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceToolNames: params.forceToolNames,
  });
  const allowedCatalogEntries = applyToolsAllow<ToolSearchCatalogEntry>(
    params.baseline.catalogEntries,
    toolsAllow,
    (entry) => getPluginToolMeta(entry.tool as AnyAgentTool),
  );
  const catalogToolCount = restrictToolSearchCatalog({
    catalogRef: params.catalogRef,
    allowedToolNames: new Set(allowedCatalogEntries.map((entry) => entry.name)),
    baselineEntries: params.baseline.catalogEntries,
  });
  const allowedEffectiveTools = applyToolsAllow(params.effectiveTools, toolsAllow);
  const allowedUncompactedTools = applyToolsAllow(params.uncompactedEffectiveTools, toolsAllow);
  const allowedTools = applyToolsAllow(params.tools, toolsAllow);
  const allowedActiveNames = new Set(
    applyToolsAllow(
      params.baseline.activeToolNames.map((name) => ({ name })),
      toolsAllow,
    ).map((tool) => normalizeToolPolicyName(tool.name)),
  );
  for (const tool of [...allowedEffectiveTools, ...allowedUncompactedTools, ...allowedTools]) {
    allowedActiveNames.add(normalizeToolPolicyName(tool.name));
  }

  const catalogControlNames = params.codeModeControlsEnabled
    ? new Set([CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME])
    : TOOL_SEARCH_CONTROL_TOOL_NAMES;
  const keepVisibleTool = (tool: NamedTool) => {
    const normalized = normalizeToolPolicyName(tool.name);
    return (
      allowedActiveNames.has(normalized) ||
      (catalogToolCount > 0 && catalogControlNames.has(normalized))
    );
  };
  const effectiveTools = params.effectiveTools.filter(keepVisibleTool);
  const activeToolNames = params.baseline.activeToolNames.filter((name) =>
    keepVisibleTool({ name }),
  );
  if (!sameToolNames(params.session.getActiveToolNames(), activeToolNames)) {
    params.session.setActiveToolsByName(activeToolNames);
  }

  return {
    activeToolNames,
    effectiveTools,
    uncompactedEffectiveTools: allowedUncompactedTools,
    tools: allowedTools,
  };
}

/** Records the fully assembled prompt boundary before preflight and submission. */
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
  | "operation"
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
    const trajectoryTools = input.toolSearchCompacted
      ? toTrajectoryToolDefinitions(input.uncompactedEffectiveTools)
      : providerVisibleTools;
    input.trajectoryRecorder?.recordEvent("context.compiled", {
      systemPrompt: input.systemPromptForHook,
      prompt: input.promptForModel,
      messages: input.sessionMessages,
      tools: trajectoryTools,
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

  if (
    attempt.operation !== "settled-tool-finalization" &&
    !skipPromptSubmission &&
    !input.isRawModelRun &&
    input.hookRunner?.hasHooks("llm_input")
  ) {
    void input.hookRunner
      .runLlmInput(
        {
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          systemPrompt: input.systemPromptForHook,
          prompt: input.llmBoundaryPromptForPrecheck,
          /** Gives hooks an isolated message snapshot they cannot mutate in-session. */
          historyMessages: input.hookMessagesForCurrentPrompt.map((message) =>
            structuredClone(message),
          ),
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
