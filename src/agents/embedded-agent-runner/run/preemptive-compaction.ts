/**
 * Estimates prompt pressure and decides pre-prompt compaction routing.
 */
import { resolveCompactionReplayPressure } from "@openclaw/ai/transports";
import type { Model } from "@openclaw/llm-core";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionContextBudgetStatus } from "../../../config/sessions.js";
import { resolveEffectiveCompactionReserveTokens } from "../../agent-compaction-constants.js";
import { SAFETY_MARGIN } from "../../compaction.js";
import type { AgentMessage, BashExecutionMessage } from "../../runtime/index.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  calculateContextTokens,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  IMAGE_BLOCK_TOKENS,
} from "../../runtime/index.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

type CompactionPressureDecision = {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  pressureSource?: string;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Diagnostic maximum plus the independently selected outgoing checkpoint's budget. */
export type PreemptiveCompactionDecision = CompactionPressureDecision & {
  compactionReplay?: CompactionPressureDecision;
};

export type CompactionReplayPressureContext = {
  model: Model;
  sessionId?: string;
  authProfileId?: string;
  enabled?: boolean;
};

/** Token pressure reported by the rendered provider-boundary prompt when available. */
export type LlmBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  renderedChars?: number;
};

type TokenPressureMode = "general" | "tool-result";

function estimateStringTokenPressure(
  text: string,
  charsPerToken = ESTIMATED_CHARS_PER_TOKEN,
  mode: TokenPressureMode = "general",
) {
  const estimatedTokens = Math.ceil(estimateStringChars(text) / charsPerToken);
  return mode === "tool-result"
    ? Math.max(Math.ceil(text.length / TOOL_RESULT_CHARS_PER_TOKEN), estimatedTokens)
    : estimatedTokens;
}

function estimateJsonPayloadTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
  mode: TokenPressureMode = "general",
): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? estimateStringTokenPressure(serialized, charsPerToken, mode)
      : 1;
  } catch {
    return 256;
  }
}

function estimateIdentifierTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
): number {
  if (value == null) {
    return 0;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return estimateStringTokenPressure(String(value), charsPerToken);
  }
  return estimateJsonPayloadTokenPressure(value, charsPerToken);
}

function estimateContentBlockTokenPressure(
  block: unknown,
  charsPerToken = ESTIMATED_CHARS_PER_TOKEN,
  mode: TokenPressureMode = "general",
): number {
  if (typeof block === "string") {
    return estimateStringTokenPressure(block, charsPerToken, mode);
  }
  if (!isRecord(block)) {
    return estimateJsonPayloadTokenPressure(block, charsPerToken, mode);
  }

  const type = block.type;
  const text = type === "text" ? block.text : type === "thinking" ? block.thinking : undefined;
  if (typeof text === "string") {
    return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(text, charsPerToken, mode);
  }
  if (type === "image") {
    return IMAGE_BLOCK_TOKENS;
  }
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS + estimateJsonPayloadTokenPressure(block, charsPerToken, mode)
  );
}

function estimateAssistantToolCallTokenPressure(block: Record<string, unknown>): number {
  const args = block.arguments ?? block.input ?? block.args ?? {};
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS +
    estimateIdentifierTokenPressure(block.name, JSON_PAYLOAD_CHARS_PER_TOKEN) +
    estimateJsonPayloadTokenPressure(args, JSON_PAYLOAD_CHARS_PER_TOKEN)
  );
}

function estimateContentTokenPressure(
  content: unknown,
  mode: TokenPressureMode = "general",
): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content, ESTIMATED_CHARS_PER_TOKEN, mode);
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, block) =>
        sum + estimateContentBlockTokenPressure(block, ESTIMATED_CHARS_PER_TOKEN, mode),
      0,
    );
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(
      content,
      mode === "tool-result" ? ESTIMATED_CHARS_PER_TOKEN : JSON_PAYLOAD_CHARS_PER_TOKEN,
      mode,
    );
  }
  return 0;
}

function estimateMessageTokenPressure(message: AgentMessage): number {
  if ("excludeFromContext" in message && message.excludeFromContext === true) {
    return 0;
  }
  // Provider replay can carry legacy aliases outside the canonical AgentMessage union.
  const legacy: Record<string, unknown> = isRecord(message) ? message : {};
  let tokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS;

  if (message.role === "toolResult" || legacy.role === "tool" || legacy.type === "toolResult") {
    const content = message.role === "toolResult" ? message.content : legacy.content;
    const toolName = message.role === "toolResult" ? message.toolName : legacy.toolName;
    tokens += estimateContentTokenPressure(content, "tool-result");
    tokens += estimateIdentifierTokenPressure(toolName ?? legacy.tool_name);
    return tokens;
  }

  if (message.role === "bashExecution") {
    const bashMessage: BashExecutionMessage = message;
    tokens += estimateStringTokenPressure(bashExecutionToText(bashMessage));
    return tokens;
  }

  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    const [prefix, suffix] =
      message.role === "branchSummary"
        ? [BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX]
        : [COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX];
    return tokens + estimateStringTokenPressure(prefix + message.summary + suffix);
  }

  if (message.role === "assistant") {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block)) {
          const blockType: unknown = block.type;
          if (blockType === "toolCall" || blockType === "tool_use") {
            tokens += estimateAssistantToolCallTokenPressure(block);
            continue;
          }
        }
        tokens += estimateContentBlockTokenPressure(block);
      }
    } else {
      tokens += estimateContentTokenPressure(message.content);
    }

    const toolCalls = legacy.toolCalls ?? legacy.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        tokens += isRecord(toolCall)
          ? estimateAssistantToolCallTokenPressure(toolCall)
          : estimateJsonPayloadTokenPressure(toolCall);
      }
    }
    return tokens;
  }

  tokens += estimateContentTokenPressure(legacy.content);
  return tokens;
}

/**
 * Estimates the prompt pressure at the LLM boundary from transcript messages,
 * optional system prompt, and current prompt text. The result intentionally
 * includes a safety margin because this path runs before provider tokenization.
 */
function estimateRenderedPromptTokens(params: { systemPrompt?: string; prompt: string }): number {
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  return (
    systemTokens + MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt)
  );
}

type TranscriptBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: "provider_context_usage" | "transcript_estimate" | "provider_compaction_estimate";
  messages: AgentMessage[];
  hasCompactionReplay: boolean;
};

function isProviderContextUsageBarrier(message: AgentMessage): boolean {
  if (message.role !== "assistant" || !message.usage) {
    return false;
  }
  // Zero unavailable and legacy CLI records describe a newer context without
  // provider provenance; scanning past them can undercount the active transcript.
  return (
    (message.api === "cli" && message.usage.contextUsage === undefined) ||
    (message.usage.contextUsage?.state === "unavailable" &&
      calculateContextTokens(message.usage) === 0)
  );
}

function resolveProviderContextBoundary(
  messages: AgentMessage[],
): { index: number; totalTokens: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isProviderContextUsageBarrier(message)) {
      return undefined;
    }
    const contextUsage = message?.role === "assistant" ? message.usage?.contextUsage : undefined;
    if (
      contextUsage?.state === "available" &&
      Number.isFinite(contextUsage.totalTokens) &&
      contextUsage.totalTokens > 0
    ) {
      return { index, totalTokens: Math.ceil(contextUsage.totalTokens) };
    }
  }
  return undefined;
}

function estimateTranscriptBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  replay?: CompactionReplayPressureContext;
}): TranscriptBoundaryTokenPressure {
  const replay = params.replay
    ? resolveCompactionReplayPressure(params.messages, params.replay.model, params.replay, {
        text: estimateStringTokenPressure,
        image: () => IMAGE_BLOCK_TOKENS,
        json: estimateJsonPayloadTokenPressure,
      })
    : undefined;
  const messages = replay?.messages ?? params.messages;
  const boundary = resolveProviderContextBoundary(messages);
  // The provider total owns transcript items through its assistant record. It has
  // no system-prompt provenance, so the current rendered prompt stays local too.
  const messagesForPressure = boundary ? messages.slice(boundary.index + 1) : messages;
  const locallyEstimatedTokens = messagesForPressure.reduce(
    (sum, message) => sum + estimateMessageTokenPressure(message),
    estimateRenderedPromptTokens(params) + (boundary ? 0 : (replay?.prefixTokens ?? 0)),
  );
  return {
    estimatedPromptTokens:
      (boundary?.totalTokens ?? 0) + Math.ceil(locallyEstimatedTokens * SAFETY_MARGIN),
    source: boundary
      ? "provider_context_usage"
      : replay
        ? "provider_compaction_estimate"
        : "transcript_estimate",
    messages,
    hasCompactionReplay: Boolean(replay),
  };
}

export function estimateLlmBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  replay?: CompactionReplayPressureContext;
}): number {
  return estimateTranscriptBoundaryTokenPressure(params).estimatedPromptTokens;
}

/** Estimates only the rendered prompt/system portion when history has already been accounted for. */
export function estimateRenderedLlmBoundaryTokenPressure(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  return Math.max(0, Math.ceil(estimateRenderedPromptTokens(params) * SAFETY_MARGIN));
}

function normalizeLlmBoundaryTokenPressure(
  pressure: LlmBoundaryTokenPressure | undefined,
): LlmBoundaryTokenPressure | undefined {
  if (!pressure || !Number.isFinite(pressure.estimatedPromptTokens)) {
    return undefined;
  }
  const estimatedPromptTokens = Math.max(0, Math.ceil(pressure.estimatedPromptTokens));
  return {
    estimatedPromptTokens,
    source: pressure.source.trim() || "rendered_llm_boundary",
    ...(typeof pressure.renderedChars === "number" && Number.isFinite(pressure.renderedChars)
      ? { renderedChars: Math.max(0, Math.ceil(pressure.renderedChars)) }
      : {}),
  };
}

/**
 * Decides whether a run should compact before submitting the prompt, and
 * whether reducible tool results can avoid or follow compaction. Rendered LLM
 * boundary pressure wins over local transcript estimates when supplied.
 */
export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  llmBoundaryTokenPressure?: LlmBoundaryTokenPressure;
  replay?: CompactionReplayPressureContext;
}): PreemptiveCompactionDecision {
  const llmBoundaryTokenPressure = normalizeLlmBoundaryTokenPressure(
    params.llmBoundaryTokenPressure,
  );
  const transcriptTokenPressure =
    llmBoundaryTokenPressure && !params.replay
      ? undefined
      : estimateTranscriptBoundaryTokenPressure({
          messages: params.messages,
          systemPrompt: params.systemPrompt,
          prompt: params.prompt,
          replay: params.replay,
        });
  // The selected provider window owns its covered prefix, including when a
  // context engine supplied an estimate of the raw transcript instead.
  const boundaryPressure = transcriptTokenPressure?.hasCompactionReplay
    ? undefined
    : llmBoundaryTokenPressure;
  const outgoingDecision = resolveCompactionPressureDecision(
    {
      messages: transcriptTokenPressure?.messages ?? params.messages,
      estimatedPromptTokens:
        boundaryPressure?.estimatedPromptTokens ??
        transcriptTokenPressure?.estimatedPromptTokens ??
        0,
      source: boundaryPressure?.source ?? transcriptTokenPressure?.source ?? "transcript_estimate",
    },
    params,
  );
  let diagnosticDecision = outgoingDecision;
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedTokenPressure = estimateTranscriptBoundaryTokenPressure({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    // Unwindowed history is diagnostic: neither its checkpoints nor its larger
    // raw estimate may authorize recovery of a different outgoing window.
    if (unwindowedTokenPressure.estimatedPromptTokens > outgoingDecision.estimatedPromptTokens) {
      diagnosticDecision = resolveCompactionPressureDecision(
        {
          ...unwindowedTokenPressure,
          source: `unwindowed_${unwindowedTokenPressure.source}`,
        },
        params,
      );
    }
  }
  return {
    ...diagnosticDecision,
    ...(transcriptTokenPressure?.hasCompactionReplay ? { compactionReplay: outgoingDecision } : {}),
  };
}

function resolveCompactionPressureDecision(
  pressure: Pick<TranscriptBoundaryTokenPressure, "messages" | "estimatedPromptTokens"> & {
    source: string;
  },
  params: { contextTokenBudget: number; reserveTokens: number; toolResultMaxChars?: number },
): CompactionPressureDecision {
  const { estimatedPromptTokens } = pressure;
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const effectiveReserveTokens = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget,
    reserveTokens: params.reserveTokens,
  });
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: pressure.messages,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    // Choose truncate-only only when available reduction comfortably exceeds the overflow.
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    pressureSource: pressure.source,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}

/** Formats the compact operator log line for one pre-prompt budget check. */
export function formatPrePromptPrecheckLog(params: {
  result: PreemptiveCompactionDecision;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionFile?: string;
}): string {
  const { result } = params;
  return (
    `[context-overflow-precheck] pre-prompt check ` +
    `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"} ` +
    `provider=${params.provider}/${params.modelId} ` +
    `route=${result.route} ` +
    `estimatedPromptTokens=${result.estimatedPromptTokens} ` +
    `pressureSource=${result.pressureSource ?? "unknown"} ` +
    `promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve} ` +
    `overflowTokens=${result.overflowTokens} ` +
    `toolResultReducibleChars=${result.toolResultReducibleChars} ` +
    `reserveTokens=${params.reserveTokens} ` +
    `effectiveReserveTokens=${result.effectiveReserveTokens} ` +
    `contextTokenBudget=${params.contextTokenBudget} ` +
    `messages=${params.messageCount} ` +
    `unwindowedMessages=${params.unwindowedMessageCount ?? params.messageCount} ` +
    `sessionFile=${params.sessionFile}`
  );
}

/** Converts the pre-prompt decision into the persisted session context-budget status record. */
export function buildPrePromptContextBudgetStatus(params: {
  result: PreemptiveCompactionDecision;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionId?: string;
  now?: number;
}): SessionContextBudgetStatus {
  const { result } = params;
  const remainingPromptBudgetTokens = Math.max(
    0,
    result.promptBudgetBeforeReserve - result.estimatedPromptTokens,
  );
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: params.now ?? Date.now(),
    provider: params.provider,
    model: params.modelId,
    route: result.route,
    shouldCompact: result.shouldCompact,
    estimatedPromptTokens: result.estimatedPromptTokens,
    contextTokenBudget: Math.max(1, Math.floor(params.contextTokenBudget)),
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    reserveTokens: Math.max(0, Math.floor(params.reserveTokens)),
    effectiveReserveTokens: result.effectiveReserveTokens,
    remainingPromptBudgetTokens,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    messageCount: Math.max(0, Math.floor(params.messageCount)),
    unwindowedMessageCount: Math.max(
      0,
      Math.floor(params.unwindowedMessageCount ?? params.messageCount),
    ),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
}
