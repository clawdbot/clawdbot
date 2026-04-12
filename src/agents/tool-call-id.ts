import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type ToolCallIdMode = "strict" | "strict9";
const NATIVE_ANTHROPIC_TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_]+$/;
const REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT = "__OPENCLAW_REDACTED__";
const SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS = ["name", "encoding", "mimeType"] as const;
const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;

const STRICT9_LEN = 9;
const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

export type ToolCallLike = {
  id: string;
  name?: string;
};

type ReplaySafeToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "strict" mode: only [a-zA-Z0-9]
 * - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
 */
export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (!id || typeof id !== "string") {
    if (mode === "strict9") {
      return "defaultid";
    }
    return "defaulttoolid";
  }

  if (mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    if (alphanumericOnly.length > 0) {
      return shortHash(alphanumericOnly, STRICT9_LEN);
    }
    return shortHash("sanitized", STRICT9_LEN);
  }

  // Some providers require strictly alphanumeric tool call IDs.
  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}

export function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

export function extractToolResultId(
  msg: Extract<AgentMessage, { role: "toolResult" }>,
): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

function isThinkingLikeBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function hasToolCallInput(block: ReplaySafeToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function normalizeAllowedToolNames(allowedToolNames?: Iterable<string>): Set<string> | null {
  if (!allowedToolNames) {
    return null;
  }
  const normalized = new Set<string>();
  for (const name of allowedToolNames) {
    if (typeof name !== "string") {
      continue;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(normalizeLowercaseStringOrEmpty(trimmed));
  }
  return normalized.size > 0 ? normalized : null;
}

function isRedactedSessionsSpawnAttachment(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const attachment = item as Record<string, unknown>;
  if (attachment.content !== REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT) {
    return false;
  }
  for (const key of Object.keys(attachment)) {
    if (key === "content") {
      continue;
    }
    if (!(SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS as readonly string[]).includes(key)) {
      return false;
    }
    if (typeof attachment[key] !== "string" || attachment[key].trim().length === 0) {
      return false;
    }
  }
  return true;
}

function toolCallNeedsReplayMutation(block: ReplaySafeToolCallBlock): boolean {
  const rawName = typeof block.name === "string" ? block.name : undefined;
  const trimmedName = rawName?.trim();
  if (rawName && rawName !== trimmedName) {
    return true;
  }
  if (normalizeLowercaseStringOrEmpty(trimmedName) !== "sessions_spawn") {
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

function hasReplaySafeToolCallName(
  block: ReplaySafeToolCallBlock,
  allowedToolNames: Set<string> | null,
): boolean {
  if (typeof block.name !== "string") {
    return false;
  }
  const trimmed = block.name.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) {
    return false;
  }
  if (!allowedToolNames) {
    return true;
  }
  return allowedToolNames.has(normalizeLowercaseStringOrEmpty(trimmed));
}

function isReplaySafeThinkingAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
  allowedToolNames: Set<string> | null,
): boolean {
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  let sawThinking = false;
  let sawToolCall = false;
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (isThinkingLikeBlock(block)) {
      sawThinking = true;
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as ReplaySafeToolCallBlock;
    if (typeof typedBlock.type !== "string" || !TOOL_CALL_TYPES.has(typedBlock.type)) {
      continue;
    }
    sawToolCall = true;
    const toolCallId = typeof typedBlock.id === "string" ? typedBlock.id.trim() : "";
    if (
      !hasToolCallInput(typedBlock) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      !hasReplaySafeToolCallName(typedBlock, allowedToolNames) ||
      toolCallNeedsReplayMutation(typedBlock)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
  }
  return sawThinking && sawToolCall;
}

function collectReplaySafeThinkingToolIds(
  messages: AgentMessage[],
  allowedToolNames: Set<string> | null,
): { reservedIds: Set<string>; preservedIndexes: Set<number> } {
  const reserved = new Set<string>();
  const preservedIndexes = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      continue;
    }
    const assistant = message;
    if (!isReplaySafeThinkingAssistantMessage(assistant, allowedToolNames)) {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.some((toolCall) => reserved.has(toolCall.id))) {
      continue;
    }
    preservedIndexes.add(index);
    for (const toolCall of toolCalls) {
      reserved.add(toolCall.id);
    }
  }
  return { reservedIds: reserved, preservedIndexes };
}

export function isValidCloudCodeAssistToolId(id: string, mode: ToolCallIdMode = "strict"): boolean {
  if (!id || typeof id !== "string") {
    return false;
  }
  if (mode === "strict9") {
    return /^[a-zA-Z0-9]{9}$/.test(id);
  }
  // Strictly alphanumeric for providers with tighter tool ID constraints
  return /^[a-zA-Z0-9]+$/.test(id);
}

function shortHash(text: string, length = 8): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function isNativeAnthropicToolUseId(id: string): boolean {
  return NATIVE_ANTHROPIC_TOOL_USE_ID_RE.test(id);
}

function makeUniqueToolId(params: { id: string; used: Set<string>; mode: ToolCallIdMode }): string {
  if (params.mode === "strict9") {
    const base = sanitizeToolCallId(params.id, params.mode);
    const candidate = base.length >= STRICT9_LEN ? base.slice(0, STRICT9_LEN) : "";
    if (candidate && !params.used.has(candidate)) {
      return candidate;
    }

    for (let i = 0; i < 1000; i += 1) {
      const hashed = shortHash(`${params.id}:${i}`, STRICT9_LEN);
      if (!params.used.has(hashed)) {
        return hashed;
      }
    }

    return shortHash(`${params.id}:${Date.now()}`, STRICT9_LEN);
  }

  const MAX_LEN = 40;

  const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
  if (!params.used.has(base)) {
    return base;
  }

  const hash = shortHash(params.id);
  // Use separator based on mode: none for strict, underscore for non-strict variants
  const separator = params.mode === "strict" ? "" : "_";
  const maxBaseLen = MAX_LEN - separator.length - hash.length;
  const clippedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
  const candidate = `${clippedBase}${separator}${hash}`;
  if (!params.used.has(candidate)) {
    return candidate;
  }

  for (let i = 2; i < 1000; i += 1) {
    const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
    const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
    if (!params.used.has(next)) {
      return next;
    }
  }

  const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
  return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}

function createOccurrenceAwareResolver(
  mode: ToolCallIdMode,
  options?: {
    preserveNativeAnthropicToolUseIds?: boolean;
    reservedIds?: Iterable<string>;
  },
): {
  resolveAssistantId: (id: string) => string;
  resolveToolResultId: (id: string) => string;
  preserveAssistantId: (id: string) => string;
} {
  const used = new Set<string>(options?.reservedIds ?? []);
  const assistantOccurrences = new Map<string, number>();
  const orphanToolResultOccurrences = new Map<string, number>();
  const pendingByRawId = new Map<string, string[]>();
  const preserveNativeAnthropicToolUseIds = options?.preserveNativeAnthropicToolUseIds === true;

  const allocate = (seed: string): string => {
    const next = makeUniqueToolId({ id: seed, used, mode });
    used.add(next);
    return next;
  };

  const allocatePreservingNativeAnthropicId = (id: string, occurrence: number): string => {
    if (
      preserveNativeAnthropicToolUseIds &&
      isNativeAnthropicToolUseId(id) &&
      occurrence === 1 &&
      !used.has(id)
    ) {
      used.add(id);
      return id;
    }
    return allocate(occurrence === 1 ? id : `${id}:${occurrence}`);
  };

  const resolveAssistantId = (id: string): string => {
    const occurrence = (assistantOccurrences.get(id) ?? 0) + 1;
    assistantOccurrences.set(id, occurrence);
    const next = allocatePreservingNativeAnthropicId(id, occurrence);
    const pending = pendingByRawId.get(id);
    if (pending) {
      pending.push(next);
    } else {
      pendingByRawId.set(id, [next]);
    }
    return next;
  };

  const resolveToolResultId = (id: string): string => {
    const pending = pendingByRawId.get(id);
    if (pending && pending.length > 0) {
      const next = pending.shift()!;
      if (pending.length === 0) {
        pendingByRawId.delete(id);
      }
      return next;
    }

    const occurrence = (orphanToolResultOccurrences.get(id) ?? 0) + 1;
    orphanToolResultOccurrences.set(id, occurrence);
    if (
      preserveNativeAnthropicToolUseIds &&
      isNativeAnthropicToolUseId(id) &&
      occurrence === 1 &&
      !used.has(id)
    ) {
      used.add(id);
      return id;
    }
    return allocate(`${id}:tool_result:${occurrence}`);
  };

  const preserveAssistantId = (id: string): string => {
    used.add(id);
    const pending = pendingByRawId.get(id);
    if (pending) {
      pending.push(id);
    } else {
      pendingByRawId.set(id, [id]);
    }
    return id;
  };

  return { resolveAssistantId, resolveToolResultId, preserveAssistantId };
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<AgentMessage, { role: "assistant" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "assistant" }> {
  const content = params.message.content;
  if (!Array.isArray(content)) {
    return params.message;
  }

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const rec = block as { type?: unknown; id?: unknown };
    const type = rec.type;
    const id = rec.id;
    if (
      (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
      typeof id !== "string" ||
      !id
    ) {
      return block;
    }
    const nextId = params.resolveId(id);
    if (nextId === id) {
      return block;
    }
    changed = true;
    return { ...(block as unknown as Record<string, unknown>), id: nextId };
  });

  if (!changed) {
    return params.message;
  }
  return { ...params.message, content: next as typeof params.message.content };
}

function rewriteToolResultIds(params: {
  message: Extract<AgentMessage, { role: "toolResult" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  const toolCallId =
    typeof params.message.toolCallId === "string" && params.message.toolCallId
      ? params.message.toolCallId
      : undefined;
  const toolUseId = (params.message as { toolUseId?: unknown }).toolUseId;
  const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;
  const sharedRawId =
    toolCallId && toolUseIdStr && toolCallId === toolUseIdStr ? toolCallId : undefined;

  const sharedResolvedId = sharedRawId ? params.resolveId(sharedRawId) : undefined;
  const nextToolCallId =
    sharedResolvedId ?? (toolCallId ? params.resolveId(toolCallId) : undefined);
  const nextToolUseId =
    sharedResolvedId ?? (toolUseIdStr ? params.resolveId(toolUseIdStr) : undefined);

  if (nextToolCallId === toolCallId && nextToolUseId === toolUseIdStr) {
    return params.message;
  }

  return {
    ...params.message,
    ...(nextToolCallId && { toolCallId: nextToolCallId }),
    ...(nextToolUseId && { toolUseId: nextToolUseId }),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * @param messages - The messages to sanitize
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 */
export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "strict",
  options?: {
    preserveNativeAnthropicToolUseIds?: boolean;
    preserveReplaySafeThinkingToolCallIds?: boolean;
    allowedToolNames?: Iterable<string>;
  },
): AgentMessage[] {
  // Strict mode: only [a-zA-Z0-9]
  // Strict9 mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
  // Sanitization can introduce collisions, and some providers also reject raw
  // duplicate tool-call IDs. Track assistant occurrences in-order so repeated
  // raw IDs receive distinct rewritten IDs, while matching tool results consume
  // the same rewritten IDs in encounter order.
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const preserveReplaySafeThinkingToolCallIds =
    options?.preserveReplaySafeThinkingToolCallIds === true;
  const replaySafeThinking = preserveReplaySafeThinkingToolCallIds
    ? collectReplaySafeThinkingToolIds(messages, allowedToolNames)
    : undefined;
  const { resolveAssistantId, resolveToolResultId, preserveAssistantId } =
    createOccurrenceAwareResolver(mode, {
      ...options,
      reservedIds: replaySafeThinking?.reservedIds,
    });

  let changed = false;
  const out = messages.map((msg, index) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (replaySafeThinking?.preservedIndexes.has(index)) {
        for (const toolCall of extractToolCallsFromAssistant(assistant)) {
          preserveAssistantId(toolCall.id);
        }
        return msg;
      }
      const next = rewriteAssistantToolCallIds({
        message: assistant,
        resolveId: resolveAssistantId,
      });
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    if (role === "toolResult") {
      const next = rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolveId: resolveToolResultId,
      });
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    return msg;
  });

  return changed ? out : messages;
}
