/** Shared fresh-request estimates for admission and compaction replacement. */
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SAFETY_MARGIN } from "../compaction-planning.js";
import type { AgentMessage, BashExecutionMessage } from "../runtime/index.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  IMAGE_BLOCK_TOKENS,
} from "../runtime/index.js";

export const ESTIMATED_CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;

type TokenPressureMode = "general" | "tool-result";

export function estimateStringTokenPressure(
  text: string,
  charsPerToken = ESTIMATED_CHARS_PER_TOKEN,
  mode: TokenPressureMode = "general",
) {
  const estimatedTokens = Math.ceil(estimateStringChars(text) / charsPerToken);
  return mode === "tool-result"
    ? Math.max(Math.ceil(text.length / TOOL_RESULT_CHARS_PER_TOKEN), estimatedTokens)
    : estimatedTokens;
}

export function estimateJsonPayloadTokenPressure(
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

export function estimateMessageTokenPressure(message: AgentMessage): number {
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
export function estimateRenderedPromptTokens(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  return (
    systemTokens + MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt)
  );
}

/** Rebuild pressure after replacement; old provider usage describes the discarded prefix. */
export function estimateFreshLlmBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  prompt: string;
  imageCount?: number;
}): number {
  const toolTokens = params.tools?.length
    ? estimateJsonPayloadTokenPressure(
        params.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      )
    : 0;
  return Math.ceil(
    (estimateRenderedPromptTokens(params) +
      toolTokens +
      (params.imageCount ?? 0) * IMAGE_BLOCK_TOKENS +
      params.messages.reduce(
        (total, message) => total + estimateMessageTokenPressure(message),
        0,
      )) *
      SAFETY_MARGIN,
  );
}
