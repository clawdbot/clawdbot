/** Sanitizes replayed tool calls and provider-specific transcript structure. */
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import { hasNonEmptyString as replayToolCallNonEmptyString } from "../../../../packages/normalization-core/src/string-coerce.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  normalizeOpenAIResponsesToolCallIds,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../embedded-agent-helpers.js";
import type { AgentMessage, StreamFn } from "../../runtime/index.js";
import {
  sanitizeToolUseResultPairing,
  sanitizeToolUseResultPairingForModel,
} from "../../session-transcript-repair.js";
import { isThinkingLikeBlock } from "../../thinking-block.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultIds,
  sanitizeToolCallIdsForCloudCodeAssist,
  type ToolCallIdMode,
} from "../../tool-call-id.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { isRunnerToolCallBlockType } from "./attempt-tool-call-block-type.js";
import { resolveToolCallName } from "./attempt-tool-call-name-resolution.js";

const REPLAY_TOOL_CALL_NAME_MAX_CHARS = 64;

type ReplayToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

type ReplayToolCallSanitizeReport = {
  messages: AgentMessage[];
  droppedAssistantMessages: number;
};

type AnthropicToolResultContentBlock = {
  type?: unknown;
  toolUseId?: unknown;
  toolCallId?: unknown;
  tool_use_id?: unknown;
  tool_call_id?: unknown;
};

function isReplaySafeThinkingTurn(content: unknown[], allowedToolNames?: Set<string>): boolean {
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isReplayToolCallBlock(block)) {
      continue;
    }
    const replayBlock = block;
    const toolCallId = typeof replayBlock.id === "string" ? replayBlock.id.trim() : "";
    if (!replayToolCallHasInput(replayBlock) || !toolCallId || seenToolCallIds.has(toolCallId)) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
    const resolvedName = resolveReplayToolCallName(rawName, toolCallId, allowedToolNames);
    if (!resolvedName || replayBlock.name !== resolvedName) {
      return false;
    }
  }
  return true;
}

function isReplayToolCallBlock(block: unknown): block is ReplayToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  return isRunnerToolCallBlockType((block as { type?: unknown }).type);
}

function replayToolCallHasInput(block: ReplayToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function collectFollowingToolResults(
  messages: AgentMessage[],
  index: number,
): { ids: Set<string>; displaced: boolean } {
  const ids = new Set<string>();
  let sawNonToolResult = false;
  let displaced = false;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const message = messages[nextIndex];
    if (!message || typeof message !== "object") {
      sawNonToolResult = true;
      continue;
    }
    if (message.role === "assistant" && assistantTurnHasReplayToolCall(message)) {
      break;
    }
    if (message.role === "toolResult") {
      const resultIds = extractToolResultIds(message);
      for (const id of resultIds) {
        ids.add(id);
      }
      displaced ||= resultIds.length > 0 && sawNonToolResult;
      continue;
    }
    sawNonToolResult = true;
  }
  return { ids, displaced };
}

function resolveReplayToolCallName(
  rawName: string,
  rawId: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (rawName.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS * 2) {
    return null;
  }
  const normalized = resolveToolCallName(rawName, allowedToolNames, rawId, true);
  if (!normalized) {
    return null;
  }
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS || /\s/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeReplayToolCallInputs(
  messages: AgentMessage[],
  allowedToolNames?: Set<string>,
  allowProviderOwnedThinkingReplay?: boolean,
): ReplayToolCallSanitizeReport {
  let changed = false;
  let droppedAssistantMessages = 0;
  const out: AgentMessage[] = [];
  const preservedThinkingToolCallIds = new Set<string>();
  const priorToolCallIds = new Set<string>();

  for (const [index, message] of messages.entries()) {
    if (!message) {
      changed = true;
      continue;
    }
    if (typeof message !== "object" || message.role !== "assistant") {
      out.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    if (
      allowProviderOwnedThinkingReplay &&
      message.content.some((block) => isThinkingLikeBlock(block)) &&
      message.content.some((block) => isReplayToolCallBlock(block))
    ) {
      const replaySafeToolCalls = extractToolCallsFromAssistant(message);
      const followingToolResults = collectFollowingToolResults(messages, index);
      if (
        isReplaySafeThinkingTurn(message.content, allowedToolNames) &&
        replaySafeToolCalls.every(
          (toolCall) =>
            !preservedThinkingToolCallIds.has(toolCall.id) &&
            (!followingToolResults.displaced || !priorToolCallIds.has(toolCall.id)) &&
            followingToolResults.ids.has(toolCall.id),
        )
      ) {
        for (const toolCall of replaySafeToolCalls) {
          preservedThinkingToolCallIds.add(toolCall.id);
          priorToolCallIds.add(toolCall.id);
        }
        changed ||= followingToolResults.displaced;
        out.push(message);
      } else {
        changed = true;
        droppedAssistantMessages += 1;
      }
      continue;
    }

    const nextContent: typeof message.content = [];
    let messageChanged = false;

    for (const block of message.content) {
      if (!isReplayToolCallBlock(block)) {
        nextContent.push(block);
        continue;
      }
      const replayBlock = block as ReplayToolCallBlock;

      if (!replayToolCallHasInput(replayBlock) || !replayToolCallNonEmptyString(replayBlock.id)) {
        changed = true;
        messageChanged = true;
        continue;
      }

      const rawName = typeof replayBlock.name === "string" ? replayBlock.name : "";
      const resolvedName = resolveReplayToolCallName(rawName, replayBlock.id, allowedToolNames);
      if (!resolvedName) {
        changed = true;
        messageChanged = true;
        continue;
      }

      if (replayBlock.name !== resolvedName) {
        nextContent.push({ ...(block as object), name: resolvedName } as typeof block);
        changed = true;
        messageChanged = true;
        continue;
      }
      nextContent.push(block);
    }

    if (messageChanged) {
      changed = true;
      if (nextContent.length > 0) {
        const nextMessage = replaceCompactionReplayOwnerContent(message, nextContent);
        for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
          priorToolCallIds.add(toolCall.id);
        }
        out.push(nextMessage);
      } else {
        droppedAssistantMessages += 1;
      }
      continue;
    }

    for (const toolCall of extractToolCallsFromAssistant(message)) {
      priorToolCallIds.add(toolCall.id);
    }
    out.push(message);
  }

  return {
    messages: changed ? out : messages,
    droppedAssistantMessages,
  };
}

function extractAnthropicReplayToolResultIds(block: AnthropicToolResultContentBlock): string[] {
  const ids: string[] = [];
  for (const value of [block.toolUseId, block.toolCallId, block.tool_use_id, block.tool_call_id]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || ids.includes(trimmed)) {
      continue;
    }
    ids.push(trimmed);
  }
  return ids;
}

function isSignedThinkingReplayAssistantSpan(message: AgentMessage | undefined): boolean {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return (
    content.some((block) => isThinkingLikeBlock(block)) &&
    content.some((block) => isReplayToolCallBlock(block))
  );
}

function sanitizeAnthropicReplayToolResults(
  messages: AgentMessage[],
  options?: {
    disallowEmbeddedUserToolResultsForSignedThinkingReplay?: boolean;
  },
): AgentMessage[] {
  let changed = false;
  const out: AgentMessage[] = [];
  const disallowEmbeddedUserToolResultsForSignedThinkingReplay =
    options?.disallowEmbeddedUserToolResultsForSignedThinkingReplay === true;

  for (const [index, message] of messages.entries()) {
    if (!message) {
      changed = true;
      continue;
    }
    if (typeof message !== "object" || message.role !== "user") {
      out.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    const previous = messages[index - 1];
    const shouldStripEmbeddedToolResults =
      disallowEmbeddedUserToolResultsForSignedThinkingReplay &&
      isSignedThinkingReplayAssistantSpan(previous);
    const validToolUseIds = new Set<string>();
    if (previous && typeof previous === "object" && previous.role === "assistant") {
      const previousContent = (previous as { content?: unknown }).content;
      if (Array.isArray(previousContent)) {
        for (const block of previousContent) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const typedBlock = block as { type?: unknown; id?: unknown };
          if (!isRunnerToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
            continue;
          }
          const trimmedId = typedBlock.id.trim();
          if (trimmedId) {
            validToolUseIds.add(trimmedId);
          }
        }
      }
    }

    const nextContent = message.content.filter((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const typedBlock = block as AnthropicToolResultContentBlock;
      if (typedBlock.type !== "toolResult" && typedBlock.type !== "tool") {
        return true;
      }
      if (shouldStripEmbeddedToolResults) {
        changed = true;
        return false;
      }
      const resultIds = extractAnthropicReplayToolResultIds(typedBlock);
      if (resultIds.length === 0) {
        changed = true;
        return false;
      }
      return validToolUseIds.size > 0 && resultIds.some((id) => validToolUseIds.has(id));
    });

    if (nextContent.length === message.content.length) {
      out.push(message);
      continue;
    }

    changed = true;
    if (nextContent.length > 0) {
      out.push({ ...message, content: nextContent });
      continue;
    }

    out.push({
      ...message,
      content: [{ type: "text", text: "[tool results omitted]" }],
    } as AgentMessage);
  }

  return changed ? out : messages;
}

function assistantTurnHasReplayToolCall(message: AgentMessage): boolean {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => isReplayToolCallBlock(block));
}

function stripTrailingAssistantPrefillTurns(messages: AgentMessage[]): AgentMessage[] {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      break;
    }
    if (assistantTurnHasReplayToolCall(message)) {
      break;
    }
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

type ReplayToolCallIdSanitizerDecision = {
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  isOpenAIResponsesApi: boolean;
};

/** Returns whether replayed tool-call ids should be sanitized for non-Responses providers. */
export function shouldApplyReplayToolCallIdSanitizer(
  params: ReplayToolCallIdSanitizerDecision,
): params is ReplayToolCallIdSanitizerDecision & { toolCallIdMode: ToolCallIdMode } {
  return (
    params.sanitizeToolCallIds && Boolean(params.toolCallIdMode) && !params.isOpenAIResponsesApi
  );
}

/** Rewrites replayed tool-call ids into provider-safe ids and optionally repairs result pairing. */
export function sanitizeReplayToolCallIdsForStream(params: {
  messages: AgentMessage[];
  mode: ToolCallIdMode;
  allowedToolNames?: Set<string>;
  preserveNativeAnthropicToolUseIds?: boolean;
  duplicateToolCallIdStyle?: "openai";
  preserveReplaySafeThinkingToolCallIds?: boolean;
  repairToolUseResultPairing?: boolean;
}): AgentMessage[] {
  const paired = params.repairToolUseResultPairing
    ? sanitizeToolUseResultPairing(params.messages)
    : params.messages;
  return sanitizeToolCallIdsForCloudCodeAssist(paired, params.mode, {
    preserveNativeAnthropicToolUseIds: params.preserveNativeAnthropicToolUseIds,
    duplicateToolCallIdStyle: params.duplicateToolCallIdStyle,
    preserveReplaySafeThinkingToolCallIds: params.preserveReplaySafeThinkingToolCallIds,
    allowedToolNames: params.allowedToolNames,
  });
}

/** Downgrades OpenAI Responses replay turns into the stream format expected by runtime callers. */
export function sanitizeOpenAIResponsesReplayForStream(messages: AgentMessage[]): AgentMessage[] {
  const repaired = sanitizeToolUseResultPairingForModel(messages, true);
  return downgradeOpenAIFunctionCallReasoningPairs(
    normalizeOpenAIResponsesToolCallIds(downgradeOpenAIReasoningBlocks(repaired)),
  );
}

/**
 * Sanitizes malformed replay tool calls before provider submission. The wrapper
 * drops invalid assistant tool calls, repairs adjacent tool results when needed,
 * strips trailing assistant prefill turns for strict providers, and revalidates
 * Anthropic/Gemini transcripts after mutations.
 */
export function wrapStreamFnSanitizeMalformedToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  transcriptPolicy?: Pick<
    TranscriptPolicy,
    "validateGeminiTurns" | "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >,
  provider?: string | null,
): StreamFn {
  return (model, context, options) => {
    const messages = context?.messages;
    if (!Array.isArray(messages)) {
      return baseFn(model, context, options);
    }
    const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
      modelApi: (model as { api?: unknown })?.api as string | null | undefined,
      provider,
      policy: {
        validateAnthropicTurns: transcriptPolicy?.validateAnthropicTurns === true,
        preserveSignatures: transcriptPolicy?.preserveSignatures === true,
        dropThinkingBlocks: transcriptPolicy?.dropThinkingBlocks === true,
      },
    });
    const sanitized = sanitizeReplayToolCallInputs(
      messages as AgentMessage[],
      allowedToolNames,
      allowProviderOwnedThinkingReplay,
    );
    const isOpenAIResponsesApi =
      (model as { api?: unknown }).api === "openai-responses" ||
      (model as { api?: unknown }).api === "openai-chatgpt-responses" ||
      (model as { api?: unknown }).api === "azure-openai-responses";
    const replayInputsChanged = sanitized.messages !== messages;
    let nextMessages = isOpenAIResponsesApi
      ? sanitizeToolUseResultPairingForModel(sanitized.messages, true)
      : replayInputsChanged
        ? sanitizeToolUseResultPairing(sanitized.messages)
        : sanitized.messages;
    let strippedTrailingAssistantPrefill = false;
    if (transcriptPolicy?.validateAnthropicTurns) {
      nextMessages = sanitizeAnthropicReplayToolResults(nextMessages, {
        disallowEmbeddedUserToolResultsForSignedThinkingReplay: allowProviderOwnedThinkingReplay,
      });
    }
    if (transcriptPolicy?.validateAnthropicTurns || transcriptPolicy?.validateGeminiTurns) {
      const beforeStrip = nextMessages;
      nextMessages = stripTrailingAssistantPrefillTurns(nextMessages);
      strippedTrailingAssistantPrefill ||= nextMessages !== beforeStrip;
    }
    if (nextMessages === messages) {
      return baseFn(model, context, options);
    }
    if (
      sanitized.droppedAssistantMessages > 0 ||
      transcriptPolicy?.validateAnthropicTurns ||
      strippedTrailingAssistantPrefill
    ) {
      if (transcriptPolicy?.validateGeminiTurns) {
        nextMessages = validateGeminiTurns(nextMessages);
      }
      if (transcriptPolicy?.validateAnthropicTurns) {
        nextMessages = validateAnthropicTurns(nextMessages);
      }
    }
    const nextContext: typeof context = {
      ...context,
      messages: nextMessages as typeof context.messages,
    };
    return baseFn(model, nextContext, options);
  };
}
