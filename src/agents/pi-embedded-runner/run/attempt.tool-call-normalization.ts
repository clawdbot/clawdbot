import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { validateAnthropicTurns, validateGeminiTurns } from "../../pi-embedded-helpers.js";
import {
  isRedactedSessionsSpawnAttachment,
  sanitizeToolUseResultPairing,
} from "../../session-transcript-repair.js";
import { extractToolCallsFromAssistant } from "../../tool-call-id.js";
import { normalizeToolName } from "../../tool-policy.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../transcript-policy.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";

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

  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
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

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
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

function hasUnredactedSessionsSpawnAttachments(block: ReplayToolCallBlock): boolean {
  const rawName = typeof block.name === "string" ? block.name.trim() : "";
  if (normalizeLowercaseStringOrEmpty(rawName) !== "sessions_spawn") {
    return false;
  }
  for (const payload of [block.arguments, block.input]) {
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const attachments = (payload as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) {
      continue;
    }
    for (const attachment of attachments) {
      if (!isRedactedSessionsSpawnAttachment(attachment)) {
        return true;
      }
    }
  }
  return false;
}

function isReplaySafeThinkingTurn(content: unknown[], allowedToolNames?: Set<string>): boolean {
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isReplayToolCallBlock(block)) {
      continue;
    }
    const replayBlock = block;
    const toolCallId = typeof replayBlock.id === "string" ? replayBlock.id.trim() : "";
    if (
      !replayToolCallHasInput(replayBlock) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      hasUnredactedSessionsSpawnAttachments(replayBlock)
    ) {
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
  return isToolCallBlockType((block as { type?: unknown }).type);
}

function replayToolCallHasInput(block: ReplayToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
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
  const claimedReplaySafeToolCallIds = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
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
      if (
        isReplaySafeThinkingTurn(message.content, allowedToolNames) &&
        replaySafeToolCalls.every((toolCall) => !claimedReplaySafeToolCallIds.has(toolCall.id))
      ) {
        for (const toolCall of replaySafeToolCalls) {
          claimedReplaySafeToolCallIds.add(toolCall.id);
        }
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
        out.push({ ...message, content: nextContent });
      } else {
        droppedAssistantMessages += 1;
      }
      continue;
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

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "user") {
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
          if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
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

function normalizeToolCallIdsInMessage(message: unknown): void {
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
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  let fallbackIndex = 1;
  const assignedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
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

    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    if (typeof typedBlock.name === "string") {
      const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
      continue;
    }
    const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
    if (inferred) {
      typedBlock.name = inferred;
    }
  }
  normalizeToolCallIdsInMessage(message);
}

function wrapStreamTrimToolCallNames(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              partial?: unknown;
              message?: unknown;
            };
            trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
            trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames);
  };
}

export function wrapStreamFnSanitizeMalformedToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  transcriptPolicy?: Pick<
    TranscriptPolicy,
    "validateGeminiTurns" | "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >,
): StreamFn {
  return (model, context, options) => {
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) {
      return baseFn(model, context, options);
    }
    const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
      modelApi: (model as { api?: unknown })?.api as string | null | undefined,
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
    const replayInputsChanged = sanitized.messages !== messages;
    let nextMessages = replayInputsChanged
      ? sanitizeToolUseResultPairing(sanitized.messages)
      : sanitized.messages;
    if (transcriptPolicy?.validateAnthropicTurns) {
      nextMessages = sanitizeAnthropicReplayToolResults(nextMessages, {
        disallowEmbeddedUserToolResultsForSignedThinkingReplay: allowProviderOwnedThinkingReplay,
      });
    }
    if (nextMessages === messages) {
      return baseFn(model, context, options);
    }
    if (sanitized.droppedAssistantMessages > 0 || transcriptPolicy?.validateAnthropicTurns) {
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
