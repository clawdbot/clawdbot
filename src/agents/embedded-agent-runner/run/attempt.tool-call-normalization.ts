/**
 * Normalizes tool-call names, ids, and standalone text calls for providers.
 */
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "../../../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../../../packages/normalization-core/src/string-normalization.js";
import {
  createPromotedPlainTextToolCallEvents,
  normalizePlainTextToolCallStreamEvents,
  projectScrubbedPlainTextToolCallMessage,
  projectStandalonePlainTextToolCallMessage as projectPlainTextToolCallMessage,
  type PlainTextToolCallBlock,
  type PlainTextToolCallMessageNormalization,
  type PlainTextToolCallNameMatcher,
} from "../../../../packages/tool-call-repair/src/index.js";
import { visitObjectContentBlocks } from "../../../shared/message-content-blocks.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  normalizeOpenAIResponsesToolCallIds,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../embedded-agent-helpers.js";
import type { AgentMessage, StreamFn } from "../../runtime/index.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultIds,
  sanitizeToolCallIdsForCloudCodeAssist,
  type ToolCallIdMode,
} from "../../tool-call-id.js";
import { couldNormalizeToolNamePrefixToAllowedTool, normalizeToolName } from "../../tool-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { isRunnerToolCallBlockType } from "./attempt.tool-call-block-type.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

const BLANK_TOOL_CALL_NAME_DESCRIPTION = "blank tool name";

type UnknownToolLoopGuardState = {
  lastUnknownToolName?: string;
  count: number;
  countedMessages: WeakSet<object>;
};
type AssistantStream = Awaited<ReturnType<StreamFn>>;

function resolveCaseInsensitiveAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const folded = normalizeLowercaseStringOrEmpty(rawName);
  let caseInsensitiveMatch: string | null = null;
  for (const name of allowedToolNames) {
    if (normalizeLowercaseStringOrEmpty(name) !== folded) {
      continue;
    }
    if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
      return null;
    }
    caseInsensitiveMatch = name;
  }
  return caseInsensitiveMatch;
}

function resolveExactAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  if (allowedToolNames.has(rawName)) {
    return rawName;
  }
  const normalized = normalizeToolName(rawName);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  return (
    resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
    resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames)
  );
}

function buildStructuredToolNameCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  addCandidate(trimmed);
  addCandidate(normalizeToolName(trimmed));

  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  addCandidate(normalizedDelimiter);
  addCandidate(normalizeToolName(normalizedDelimiter));

  const segments = normalizeStringEntries(normalizedDelimiter.split("."));
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      addCandidate(suffix);
      addCandidate(normalizeToolName(suffix));
    }
  }

  return candidates;
}

function resolveStructuredAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }

  const candidateNames = buildStructuredToolNameCandidates(rawName);
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidateNames) {
    const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }

  return null;
}

function inferToolNameFromToolCallId(
  rawId: string | undefined,
  allowedToolNames?: Set<string>,
): string | null {
  if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const candidateTokens = new Set<string>();
  const addToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidateTokens.add(trimmed);
    candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
    candidateTokens.add(trimmed.replace(/\d+$/, ""));

    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    candidateTokens.add(normalizedDelimiter);
    candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
    candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));

    for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
      const stripped = normalizedDelimiter.replace(prefixPattern, "");
      if (stripped !== normalizedDelimiter) {
        candidateTokens.add(stripped);
        candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(stripped.replace(/\d+$/, ""));
      }
    }
  };

  const preColon = id.split(":")[0] ?? id;
  for (const seed of [id, preColon]) {
    addToken(seed);
  }

  let singleMatch: string | null = null;
  for (const candidate of candidateTokens) {
    const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
    if (!matched) {
      continue;
    }
    if (singleMatch && singleMatch !== matched) {
      return null;
    }
    singleMatch = matched;
  }

  return singleMatch;
}

function looksLikeMalformedToolNameCounter(rawName: string): boolean {
  const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
  return (
    /^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
    /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter)
  );
}

function normalizeToolCallNameForDispatch(
  rawName: string,
  allowedToolNames?: Set<string>,
  rawToolCallId?: string,
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ?? rawName;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
  if (exact) {
    return exact;
  }
  const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
  if (inferredFromName) {
    return inferredFromName;
  }

  if (looksLikeMalformedToolNameCounter(trimmed)) {
    return trimmed;
  }

  return resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? trimmed;
}

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

function isThinkingLikeReplayBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

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

function replayToolCallNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveReplayToolCallName(
  rawName: string,
  rawId: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (rawName.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS * 2) {
    return null;
  }
  const normalized = normalizeToolCallNameForDispatch(rawName, allowedToolNames, rawId);
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS || /\s/.test(trimmed)) {
    return null;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }
  return resolveExactAllowedToolName(trimmed, allowedToolNames);
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
      message.content.some((block) => isThinkingLikeReplayBlock(block)) &&
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
        const nextMessage = { ...message, content: nextContent };
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
    content.some((block) => isThinkingLikeReplayBlock(block)) &&
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

function createStandaloneTextToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeToolCallIdsInMessage(message: unknown, fallbackIdByContentIndex: string[]): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  const assignedIds = new Set<string>();
  for (const [contentIndex, block] of content.entries()) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    let fallbackId = fallbackIdByContentIndex[contentIndex];
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = createStandaloneTextToolCallId();
    }
    fallbackIdByContentIndex[contentIndex] = fallbackId;
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames: Set<string> | undefined,
  fallbackIdByContentIndex: string[],
): void {
  visitObjectContentBlocks(message, (block) => {
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type)) {
      return;
    }
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    if (typeof typedBlock.name === "string") {
      const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
      return;
    }
    const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
    if (inferred) {
      typedBlock.name = inferred;
    }
  });
  normalizeToolCallIdsInMessage(message, fallbackIdByContentIndex);
}

function classifyToolCallMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
):
  | { kind: "none" }
  | { kind: "allowed" }
  | { kind: "incomplete" }
  | { kind: "malformed"; toolName: string }
  | { kind: "unknown"; toolName: string } {
  if (!message || typeof message !== "object") {
    return { kind: "none" };
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { kind: "none" };
  }

  let unknownToolName: string | undefined;
  let sawToolCall = false;
  let sawAllowedToolCall = false;
  let sawIncompleteToolCall = false;
  let sawBlankStringToolCall = false;
  const hasAllowedToolNames = Boolean(allowedToolNames && allowedToolNames.size > 0);
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown };
    if (!isRunnerToolCallBlockType(typedBlock.type)) {
      continue;
    }
    sawToolCall = true;
    const rawBlockName = typedBlock.name;
    const hasStringName = typeof rawBlockName === "string";
    const rawName = hasStringName ? rawBlockName.trim() : "";
    if (!rawName) {
      if (hasStringName) {
        sawBlankStringToolCall = true;
      } else {
        sawIncompleteToolCall = true;
      }
      continue;
    }
    if (!hasAllowedToolNames) {
      continue;
    }
    if (resolveExactAllowedToolName(rawName, allowedToolNames)) {
      sawAllowedToolCall = true;
      continue;
    }
    const normalizedUnknownToolName = normalizeToolName(rawName);
    if (!unknownToolName) {
      unknownToolName = normalizedUnknownToolName;
      continue;
    }
    if (unknownToolName !== normalizedUnknownToolName) {
      sawIncompleteToolCall = true;
    }
  }

  if (!sawToolCall) {
    return { kind: "none" };
  }
  if (!hasAllowedToolNames) {
    return sawBlankStringToolCall
      ? { kind: "malformed", toolName: BLANK_TOOL_CALL_NAME_DESCRIPTION }
      : { kind: "none" };
  }
  if (sawAllowedToolCall) {
    return { kind: "allowed" };
  }
  if (sawBlankStringToolCall && !sawIncompleteToolCall && unknownToolName === undefined) {
    return { kind: "malformed", toolName: BLANK_TOOL_CALL_NAME_DESCRIPTION };
  }
  if (sawIncompleteToolCall) {
    return { kind: "incomplete" };
  }
  return unknownToolName ? { kind: "unknown", toolName: unknownToolName } : { kind: "incomplete" };
}

function rewriteUnknownToolLoopMessage(message: unknown, toolName: string): void {
  if (!message || typeof message !== "object") {
    return;
  }
  (message as { content?: unknown }).content = [
    {
      type: "text",
      text: `I can't use the tool "${toolName}" here because it isn't available. I need to stop retrying it and answer without that tool.`,
    },
  ];
}

function guardUnknownToolLoopInMessage(
  message: unknown,
  state: UnknownToolLoopGuardState,
  params: {
    allowedToolNames?: Set<string>;
    threshold?: number;
    countAttempt: boolean;
    resetOnAllowedTool?: boolean;
    resetOnMissingUnknownTool?: boolean;
    rewriteMalformedBlankToolName?: boolean;
  },
): boolean {
  const toolCallState = classifyToolCallMessage(message, params.allowedToolNames);
  if (toolCallState.kind === "allowed") {
    if (params.resetOnAllowedTool === true) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  if (toolCallState.kind === "malformed") {
    if (params.rewriteMalformedBlankToolName === true) {
      rewriteUnknownToolLoopMessage(message, toolCallState.toolName);
      return true;
    }
    if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const threshold = params.threshold;
  if (threshold === undefined || threshold <= 0) {
    return false;
  }
  if (toolCallState.kind !== "unknown") {
    if (params.countAttempt && params.resetOnMissingUnknownTool !== false) {
      state.lastUnknownToolName = undefined;
      state.count = 0;
    }
    return false;
  }
  const unknownToolName = toolCallState.toolName;

  if (!params.countAttempt) {
    // Partial stream events can rewrite after the threshold, but only final
    // messages advance the loop counter.
    if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
      rewriteUnknownToolLoopMessage(message, unknownToolName);
    }
    return false;
  }

  if (message && typeof message === "object") {
    if (state.countedMessages.has(message)) {
      if (state.lastUnknownToolName === unknownToolName && state.count > threshold) {
        rewriteUnknownToolLoopMessage(message, unknownToolName);
      }
      return true;
    }
    state.countedMessages.add(message);
  }

  if (state.lastUnknownToolName === unknownToolName) {
    state.count += 1;
  } else {
    state.lastUnknownToolName = unknownToolName;
    state.count = 1;
  }

  if (state.count > threshold) {
    rewriteUnknownToolLoopMessage(message, unknownToolName);
  }
  return true;
}

function isRetainableNonVisibleBlock(block: Record<string, unknown>): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

const STANDALONE_TEXT_TOOL_CALL_PROMOTION_STOP_REASONS = new Set<unknown>(["stop", "toolUse"]);

function createStandaloneToolCallNameMatcher(
  allowedToolNames: Set<string>,
): PlainTextToolCallNameMatcher {
  return {
    hasExactName: (name) => Boolean(resolveExactAllowedToolName(name, allowedToolNames)),
    hasNamePrefix: (prefix) => couldNormalizeToolNamePrefixToAllowedTool(prefix, allowedToolNames),
  };
}

function wrapStreamPromoteStandaloneTextToolCalls(
  stream: AssistantStream,
  allowedToolNames: Set<string>,
): AssistantStream {
  const matcher = createStandaloneToolCallNameMatcher(allowedToolNames);
  const promotedIdBySource = new Map<string, string>();
  const normalizeTerminalMessage = (params: {
    allowPromotion: boolean;
    message: unknown;
    preserveEmptyTextBlocks?: boolean;
  }): PlainTextToolCallMessageNormalization => {
    const scrubbed = projectScrubbedPlainTextToolCallMessage({
      forceIncompleteCandidates: true,
      matcher,
      message: params.message,
      preserveEmptyTextBlocks: params.preserveEmptyTextBlocks,
      requireAssistantRole: true,
    });
    if (scrubbed) {
      return { kind: "scrubbed", ...scrubbed };
    }
    if (!params.allowPromotion) {
      return undefined;
    }
    let ordinal = 0;
    const createStableToolCallBlock = (
      block: PlainTextToolCallBlock,
      name: string,
    ): Record<string, unknown> => {
      const sourceKey = `${ordinal}:${block.start}:${block.end}`;
      ordinal += 1;
      let id = promotedIdBySource.get(sourceKey);
      if (!id) {
        id = createStandaloneTextToolCallId();
        promotedIdBySource.set(sourceKey, id);
      }
      return {
        type: "toolCall",
        id,
        name,
        arguments: block.arguments,
        partialArgs: JSON.stringify(block.arguments),
      };
    };
    const promoted = projectPlainTextToolCallMessage({
      allowedStopReasons: STANDALONE_TEXT_TOOL_CALL_PROMOTION_STOP_REASONS,
      allowedToolNames,
      createToolCallBlock: createStableToolCallBlock,
      isRetainableNonTextBlock: isRetainableNonVisibleBlock,
      message: params.message,
      requireAssistantRole: true,
      resolveToolName: resolveExactAllowedToolName,
    });
    return promoted ? { kind: "promoted", ...promoted } : undefined;
  };

  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    const reason =
      message && typeof message === "object"
        ? (message as { stopReason?: unknown }).stopReason
        : undefined;
    return (normalizeTerminalMessage({
      allowPromotion: STANDALONE_TEXT_TOOL_CALL_PROMOTION_STOP_REASONS.has(reason),
      message,
    })?.message ?? message) as Awaited<ReturnType<typeof originalResult>>;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[
    Symbol.asyncIterator
  ] = async function* () {
    const source = {
      [Symbol.asyncIterator]: originalAsyncIterator,
    } as AsyncIterable<unknown>;
    yield* normalizePlainTextToolCallStreamEvents(source, {
      createPromotedToolCallEvents: createPromotedPlainTextToolCallEvents,
      matcher,
      normalizeTerminalMessage,
    });
  };

  return stream;
}

/** Promotes standalone plain-text tool-call replies into structured toolCall blocks when safe. */
export function wrapStreamFnPromoteStandaloneTextToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return baseFn;
  }
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamPromoteStandaloneTextToolCalls(stream, allowedToolNames),
      );
    }
    return wrapStreamPromoteStandaloneTextToolCalls(maybeStream, allowedToolNames);
  };
}

function wrapStreamTrimToolCallNames(
  stream: AssistantStream,
  allowedToolNames?: Set<string>,
  options?: { unknownToolThreshold?: number; state?: UnknownToolLoopGuardState },
): AssistantStream {
  const unknownToolGuardState = options?.state ?? {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  // Provider-omitted ids are only message-local. Reuse one generated id per
  // content position across this response's partial/final projections, while a
  // later assistant response gets a fresh namespace and cannot alias it.
  const fallbackIdByContentIndex: string[] = [];
  let streamAttemptAlreadyCounted = false;
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames, fallbackIdByContentIndex);
    guardUnknownToolLoopInMessage(message, unknownToolGuardState, {
      allowedToolNames,
      threshold: options?.unknownToolThreshold,
      countAttempt: !streamAttemptAlreadyCounted,
      resetOnAllowedTool: true,
      rewriteMalformedBlankToolName: true,
    });
    return message;
  };

  wrapStreamObjectEvents(stream, (event) => {
    trimWhitespaceFromToolCallNamesInMessage(
      event.partial,
      allowedToolNames,
      fallbackIdByContentIndex,
    );
    trimWhitespaceFromToolCallNamesInMessage(
      event.message,
      allowedToolNames,
      fallbackIdByContentIndex,
    );
    if (event.message && typeof event.message === "object") {
      const countedStreamAttempt = guardUnknownToolLoopInMessage(
        event.message,
        unknownToolGuardState,
        {
          allowedToolNames,
          threshold: options?.unknownToolThreshold,
          countAttempt: !streamAttemptAlreadyCounted,
          resetOnAllowedTool: true,
          resetOnMissingUnknownTool: false,
        },
      );
      streamAttemptAlreadyCounted ||= countedStreamAttempt;
    }
    guardUnknownToolLoopInMessage(event.partial, unknownToolGuardState, {
      allowedToolNames,
      threshold: options?.unknownToolThreshold,
      countAttempt: false,
    });
  });

  return stream;
}

/** Normalizes streamed tool-call names and guards repeated unknown-tool loops. */
export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  guardOptions?: { unknownToolThreshold?: number },
): StreamFn {
  const unknownToolGuardState: UnknownToolLoopGuardState = {
    count: 0,
    countedMessages: new WeakSet<object>(),
  };
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames, {
          unknownToolThreshold: guardOptions?.unknownToolThreshold,
          state: unknownToolGuardState,
        }),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames, {
      unknownToolThreshold: guardOptions?.unknownToolThreshold,
      state: unknownToolGuardState,
    });
  };
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
  const sanitized = sanitizeToolCallIdsForCloudCodeAssist(params.messages, params.mode, {
    preserveNativeAnthropicToolUseIds: params.preserveNativeAnthropicToolUseIds,
    duplicateToolCallIdStyle: params.duplicateToolCallIdStyle,
    preserveReplaySafeThinkingToolCallIds: params.preserveReplaySafeThinkingToolCallIds,
    allowedToolNames: params.allowedToolNames,
  });
  if (!params.repairToolUseResultPairing) {
    return sanitized;
  }
  return sanitizeToolUseResultPairing(sanitized);
}

/** Downgrades OpenAI Responses replay turns into the stream format expected by runtime callers. */
export function sanitizeOpenAIResponsesReplayForStream(messages: AgentMessage[]): AgentMessage[] {
  const repaired = sanitizeToolUseResultPairing(messages, {
    erroredAssistantResultPolicy: "drop",
    missingToolResultText: "aborted",
  });
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
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
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
      ? sanitizeToolUseResultPairing(sanitized.messages, {
          erroredAssistantResultPolicy: "drop",
          missingToolResultText: "aborted",
        })
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
    const nextContext = {
      ...(context as unknown as Record<string, unknown>),
      messages: nextMessages,
    } as unknown;
    return baseFn(model, nextContext as typeof context, options);
  };
}
