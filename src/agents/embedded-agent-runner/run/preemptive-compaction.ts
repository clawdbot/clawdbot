import type { SessionContextBudgetStatus } from "../../../config/sessions.js";
import { isRecord } from "../../../shared/record-coerce.js";
import { estimateStringChars } from "../../../utils/cjk-chars.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../agent-compaction-constants.js";
import { SAFETY_MARGIN } from "../../compaction.js";
import type { AgentMessage } from "../../runtime/index.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;
const IMAGE_BLOCK_TOKENS = 2_000;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export type PreemptiveCompactionDecision = {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  pressureSource?: string;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

export type LlmBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  renderedChars?: number;
};

function estimateStringTokenPressure(text: string, charsPerToken = ESTIMATED_CHARS_PER_TOKEN) {
  return Math.ceil(estimateStringChars(text) / charsPerToken);
}

function estimateJsonPayloadTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? Math.ceil(estimateStringChars(serialized) / charsPerToken)
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
): number {
  if (typeof block === "string") {
    return estimateStringTokenPressure(block, charsPerToken);
  }
  if (!isRecord(block)) {
    return estimateJsonPayloadTokenPressure(block, charsPerToken);
  }

  const type = block.type;
  if (type === "text" && typeof block.text === "string") {
    return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.text, charsPerToken);
  }
  if (type === "thinking" && typeof block.thinking === "string") {
    return (
      CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.thinking, charsPerToken)
    );
  }
  if (type === "image") {
    return IMAGE_BLOCK_TOKENS;
  }
  return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateJsonPayloadTokenPressure(block, charsPerToken);
}

function estimateToolResultContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content, TOOL_RESULT_CHARS_PER_TOKEN);
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, block) => sum + estimateContentBlockTokenPressure(block, TOOL_RESULT_CHARS_PER_TOKEN),
      0,
    );
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content, TOOL_RESULT_CHARS_PER_TOKEN);
  }
  return 0;
}

function estimateAssistantToolCallTokenPressure(block: Record<string, unknown>): number {
  const args = block.arguments ?? block.input ?? block.args ?? {};
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS +
    estimateIdentifierTokenPressure(block.name, JSON_PAYLOAD_CHARS_PER_TOKEN) +
    estimateJsonPayloadTokenPressure(args, JSON_PAYLOAD_CHARS_PER_TOKEN)
  );
}

function estimateContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateContentBlockTokenPressure(block), 0);
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content);
  }
  return 0;
}

function isToolResultMessage(message: AgentMessage): boolean {
  const record = message as unknown as { role?: unknown; type?: unknown };
  return record.role === "toolResult" || record.role === "tool" || record.type === "toolResult";
}

function estimateMessageTokenPressure(message: AgentMessage): number {
  const record = message as unknown as Record<string, unknown>;
  let tokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS;

  if (isToolResultMessage(message)) {
    tokens += estimateToolResultContentTokenPressure(record.content);
    tokens += estimateIdentifierTokenPressure(record.toolName ?? record.tool_name);
    return tokens;
  }

  if (record.role === "assistant") {
    const content = record.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && (block.type === "toolCall" || block.type === "tool_use")) {
          tokens += estimateAssistantToolCallTokenPressure(block);
        } else {
          tokens += estimateContentBlockTokenPressure(block);
        }
      }
    } else {
      tokens += estimateContentTokenPressure(content);
    }

    const toolCalls = record.toolCalls ?? record.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        tokens += isRecord(toolCall)
          ? estimateAssistantToolCallTokenPressure(toolCall)
          : estimateJsonPayloadTokenPressure(toolCall);
      }
    }
    return tokens;
  }

  tokens += estimateContentTokenPressure(record.content);
  return tokens;
}

export function estimateLlmBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const historyTokens = params.messages.reduce(
    (sum, message) => sum + estimateMessageTokenPressure(message),
    0,
  );
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  const promptTokens =
    MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
  return Math.max(0, Math.ceil((historyTokens + systemTokens + promptTokens) * SAFETY_MARGIN));
}

export function estimateRenderedLlmBoundaryTokenPressure(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  const promptTokens =
    MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
  return Math.max(0, Math.ceil((systemTokens + promptTokens) * SAFETY_MARGIN));
}

type MeasuredPromptAnchor = {
  /** Provider-reported prompt+output tokens of the last assistant call. */
  baseTokens: number;
  /** Index of the anchoring assistant message inside the scanned array. */
  anchorIndex: number;
};

function toFiniteNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Find the newest assistant message carrying real provider usage. Everything
 * up to and including that call has a MEASURED size: the provider billed
 * `input + cacheRead + cacheWrite` prompt tokens for the full context
 * (system prompt, tools, history) and `output` for the reply, so the next
 * prompt's true size is that total plus only the messages appended since.
 *
 * Char-ratio estimation is kept ONLY for the unmeasured suffix. This exists
 * because the pure char estimate over-counted a real 44,984-token session as
 * 64,001 (tool results are charged at 2 chars/token, then everything x1.2
 * SAFETY_MARGIN) and rejected prompts that fit with a third of the model's
 * window to spare -- an empty turn born entirely from arithmetic.
 *
 * Returns undefined when no assistant message carries usable usage (fresh
 * session, or compaction replaced history) -- callers fall back to the char
 * estimate, which is the pre-existing behavior.
 */
function resolveMeasuredPromptAnchor(messages: AgentMessage[]): MeasuredPromptAnchor | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = messages[index] as unknown as Record<string, unknown>;
    if (record.role !== "assistant" || !isRecord(record.usage)) {
      continue;
    }
    const usage = record.usage as Record<string, unknown>;
    const input = toFiniteNonNegative(usage.input);
    const output = toFiniteNonNegative(usage.output);
    if (input === undefined || output === undefined) {
      continue;
    }
    const promptTokens =
      input +
      (toFiniteNonNegative(usage.cacheRead) ?? 0) +
      (toFiniteNonNegative(usage.cacheWrite) ?? 0);
    if (promptTokens <= 0) {
      // Zeroed usage (provider did not report) is not a measurement.
      continue;
    }
    return { baseTokens: promptTokens + output, anchorIndex: index };
  }
  return undefined;
}

/** The anchor's measured token total, for diagnostics (observedTokens=...). */
export function resolveMeasuredPromptAnchorTokens(
  messages: AgentMessage[] | undefined,
): number | undefined {
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }
  return resolveMeasuredPromptAnchor(messages)?.baseTokens;
}

export function estimatePrePromptTokensWithSource(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): { estimatedPromptTokens: number; source: string } {
  const anchor = resolveMeasuredPromptAnchor(params.messages);
  if (!anchor) {
    return {
      estimatedPromptTokens: estimateLlmBoundaryTokenPressure(params),
      source: "transcript_estimate",
    };
  }
  const suffixTokens = params.messages
    .slice(anchor.anchorIndex + 1)
    .reduce((sum, message) => sum + estimateMessageTokenPressure(message), 0);
  const promptTokens =
    MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
  // The system prompt is already inside the anchor's measured input tokens;
  // re-adding it would double-count the whole bootstrap. SAFETY_MARGIN
  // applies only to the estimated suffix -- the measured base needs none.
  return {
    estimatedPromptTokens: Math.max(
      0,
      anchor.baseTokens + Math.ceil((suffixTokens + promptTokens) * SAFETY_MARGIN),
    ),
    source: "measured_anchor",
  };
}

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  return estimatePrePromptTokensWithSource(params).estimatedPromptTokens;
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

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  llmBoundaryTokenPressure?: LlmBoundaryTokenPressure;
}): PreemptiveCompactionDecision {
  let messagesForPressure = params.messages;
  const llmBoundaryTokenPressure = normalizeLlmBoundaryTokenPressure(
    params.llmBoundaryTokenPressure,
  );
  const basePressure = estimatePrePromptTokensWithSource({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
  });
  let estimatedPromptTokens =
    llmBoundaryTokenPressure?.estimatedPromptTokens ?? basePressure.estimatedPromptTokens;
  let pressureSource = llmBoundaryTokenPressure?.source ?? basePressure.source;
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedPressure = estimatePrePromptTokensWithSource({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    if (unwindowedPressure.estimatedPromptTokens > estimatedPromptTokens) {
      estimatedPromptTokens = unwindowedPressure.estimatedPromptTokens;
      messagesForPressure = params.unwindowedMessages;
      pressureSource =
        unwindowedPressure.source === "measured_anchor"
          ? "unwindowed_measured_anchor"
          : "unwindowed_transcript_estimate";
    }
  }
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: messagesForPressure,
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
    pressureSource,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}

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
