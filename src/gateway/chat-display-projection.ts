import { createHash } from "node:crypto";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import {
  INTER_SESSION_PROMPT_PREFIX_BASE,
  normalizeInputProvenance,
} from "../sessions/input-provenance.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { stripEnvelopeFromMessages } from "./chat-sanitize.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

export const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8_000;

type RoleContentMessage = {
  role: string;
  content?: unknown;
};

type PendingMessageToolVisibleReply = {
  toolCallId?: string;
  text: string;
  anchor: Record<string, unknown>;
  completionAnchor?: Record<string, unknown>;
  succeeded: boolean;
};

export function resolveEffectiveChatHistoryMaxChars(
  cfg: { gateway?: { webchat?: { chatHistoryMaxChars?: number } } },
  maxChars?: number,
): number {
  if (typeof maxChars === "number") {
    return maxChars;
  }
  if (typeof cfg.gateway?.webchat?.chatHistoryMaxChars === "number") {
    return cfg.gateway.webchat.chatHistoryMaxChars;
  }
  return DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
}

function truncateChatHistoryText(
  text: string,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n...(truncated)...`,
    truncated: true,
  };
}

export function isToolHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "toolcall" ||
    normalized === "tool_call" ||
    normalized === "tooluse" ||
    normalized === "tool_use" ||
    normalized === "toolresult" ||
    normalized === "tool_result"
  );
}

function sanitizeChatHistoryContentBlock(
  block: unknown,
  opts?: { preserveExactToolPayload?: boolean; maxChars?: number },
): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  const preserveExactToolPayload =
    opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
  const maxChars = opts?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.partialJson === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.partialJson, maxChars);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.arguments, maxChars);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking, maxChars);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  if ("openclawReasoningReplay" in entry) {
    delete entry.openclawReasoningReplay;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  if (type === "audio" && entry.source && typeof entry.source === "object") {
    const source = { ...(entry.source as Record<string, unknown>) };
    if (source.type === "base64" && typeof source.data === "string") {
      const bytes = Buffer.byteLength(source.data, "utf8");
      delete source.data;
      source.omitted = true;
      source.bytes = bytes;
      entry.source = source;
      changed = true;
    }
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeAssistantPhasedContentBlocks(content: unknown[]): {
  content: unknown[];
  changed: boolean;
} {
  const hasExplicitPhasedText = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    return (
      entry.type === "text" && Boolean(parseAssistantTextSignature(entry.textSignature)?.phase)
    );
  });
  if (!hasExplicitPhasedText) {
    return { content, changed: false };
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    if (entry.type !== "text") {
      return true;
    }
    return parseAssistantTextSignature(entry.textSignature)?.phase === "final_answer";
  });
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

function projectAssistantTextFromMixedToolContent(
  content: unknown[],
  maxChars: number,
): { content: unknown[]; changed: boolean } | null {
  const hasToolHistoryBlock = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
  if (!hasToolHistoryBlock) {
    return null;
  }

  const textBlocks: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) {
      continue;
    }
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const truncated = truncateChatHistoryText(stripped.text, maxChars);
    if (truncated.text.trim()) {
      textBlocks.push({ type: "text", text: truncated.text });
    }
  }

  return textBlocks.length > 0 ? { content: textBlocks, changed: true } : null;
}

function toFiniteNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function sanitizeCost(raw: unknown): { total?: number } | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const total = toFiniteNumber(c.total);
  return total !== undefined ? { total } : undefined;
}

function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  const knownFields = [
    "input",
    "output",
    "total",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "cacheRead",
    "cacheWrite",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
  ];

  for (const k of knownFields) {
    const n = toFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const preserveExactToolPayload =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    role === "function" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string" ||
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string";

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }

  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) =>
      sanitizeChatHistoryContentBlock(block, { preserveExactToolPayload, maxChars }),
    );
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      const mixedToolText = projectAssistantTextFromMixedToolContent(entry.content, maxChars);
      if (mixedToolText) {
        entry.content = mixedToolText.content;
        if (entry.phase === "commentary") {
          delete entry.phase;
        }
        changed = true;
      } else {
        const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
        if (sanitizedPhases.changed) {
          entry.content = sanitizedPhases.content;
          changed = true;
        }
      }
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }

  return { message: changed ? entry : message, changed };
}

function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function hasAssistantNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type !== "text",
  );
}

function hasAssistantMixedToolVisibleText(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasToolHistoryBlock = false;
  let hasText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (isToolHistoryBlockType(entry.type)) {
      hasToolHistoryBlock = true;
    }
    if (entry.type === "text" && typeof entry.text === "string" && entry.text.trim()) {
      hasText = true;
    }
  }
  return hasToolHistoryBlock && hasText;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeToolHistoryType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ? normalized.replace(/_/g, "") : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readMaybeJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    return parseJsonRecord(value);
  }
  return readRecord(value);
}

function readToolBlockName(block: Record<string, unknown>): string | undefined {
  const direct =
    normalizeOptionalString(block.name) ??
    normalizeOptionalString(block.toolName) ??
    normalizeOptionalString(block.tool_name) ??
    normalizeOptionalString(block.tool);
  if (direct) {
    return direct;
  }
  const fn = readRecord(block.function);
  return fn ? normalizeOptionalString(fn.name) : undefined;
}

function readToolBlockCallId(block: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(block.id) ??
    normalizeOptionalString(block.toolCallId) ??
    normalizeOptionalString(block.tool_call_id) ??
    normalizeOptionalString(block.callId) ??
    normalizeOptionalString(block.call_id)
  );
}

function readToolBlockArguments(block: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["arguments", "input", "args", "params"] as const) {
    const args = readMaybeJsonRecord(block[key]);
    if (args) {
      return args;
    }
  }
  const fn = readRecord(block.function);
  if (fn) {
    const args = readMaybeJsonRecord(fn.arguments);
    if (args) {
      return args;
    }
  }
  return {};
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some(hasNonEmptyValue);
  }
  if (!value || typeof value !== "object") {
    return value != null;
  }
  return Object.values(value as Record<string, unknown>).some(hasNonEmptyValue);
}

function hasExplicitMessageToolRoute(args: Record<string, unknown>): boolean {
  // Channel/provider select the transport; only concrete target ids move the send off-chat.
  const routeFields = [
    "target",
    "targets",
    "to",
    "recipient",
    "recipients",
    "chatId",
    "chat_id",
    "channelId",
    "channel_id",
    "conversationId",
    "conversation_id",
    "threadId",
    "thread_id",
    "roomId",
    "room_id",
    "groupId",
    "group_id",
  ];
  return routeFields.some((field) => hasNonEmptyValue(args[field]));
}

function readMessageToolVisibleText(args: Record<string, unknown>): string | undefined {
  for (const field of ["message", "text", "content", "body", "caption"] as const) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) {
      return stripInlineDirectiveTagsForDisplay(value).text;
    }
  }
  return undefined;
}

function isDryRunMessageToolRecord(record: Record<string, unknown>): boolean {
  if (record.dryRun === true || record.dry_run === true) {
    return true;
  }
  const deliveryStatus =
    normalizeOptionalString(record.deliveryStatus) ??
    normalizeOptionalString(record.delivery_status) ??
    normalizeOptionalString(record.status);
  return deliveryStatus?.toLowerCase() === "dry_run";
}

function extractMessageToolVisibleReplies(
  message: Record<string, unknown>,
): Array<Omit<PendingMessageToolVisibleReply, "anchor" | "succeeded">> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const replies: Array<Omit<PendingMessageToolVisibleReply, "anchor" | "succeeded">> = [];
  for (const block of message.content) {
    const record = readRecord(block);
    if (!record) {
      continue;
    }
    const type = normalizeToolHistoryType(record.type);
    if (type !== "toolcall" && type !== "tooluse") {
      continue;
    }
    if (readToolBlockName(record)?.toLowerCase() !== "message") {
      continue;
    }
    const args = readToolBlockArguments(record);
    if (normalizeOptionalString(args.action)?.toLowerCase() !== "send") {
      continue;
    }
    if (isDryRunMessageToolRecord(args)) {
      continue;
    }
    if (hasExplicitMessageToolRoute(args)) {
      continue;
    }
    const text = readMessageToolVisibleText(args);
    if (!text?.trim()) {
      continue;
    }
    const toolCallId = readToolBlockCallId(record);
    replies.push({ ...(toolCallId ? { toolCallId } : {}), text });
  }
  return replies;
}

function isAssistantSilentControlReplyOnly(message: Record<string, unknown>): boolean {
  const text = extractAssistantTextForSilentCheck(message);
  return (
    text !== undefined && isSuppressedControlReplyText(text) && !hasAssistantNonTextContent(message)
  );
}

function isRenderableAssistantDisplayMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const text = extractAssistantTextForSilentCheck(message);
  return text !== undefined && !isSuppressedControlReplyText(text);
}

function readMessageToolResultName(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    normalizeOptionalString(message.name) ??
    normalizeOptionalString(message.tool)
  );
}

function readMessageToolResultCallId(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolCallId) ??
    normalizeOptionalString(message.tool_call_id) ??
    normalizeOptionalString(message.callId) ??
    normalizeOptionalString(message.call_id) ??
    normalizeOptionalString(message.id)
  );
}

function readToolResultOkValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const record = readMaybeJsonRecord(value);
  if (record && typeof record.ok === "boolean") {
    return record.ok;
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const blockOk = readToolResultOkValue(block);
      if (blockOk !== undefined) {
        return blockOk;
      }
      const recordBlock = readRecord(block);
      if (typeof recordBlock?.text === "string") {
        const textOk = readToolResultOkValue(recordBlock.text);
        if (textOk !== undefined) {
          return textOk;
        }
      }
      if (typeof recordBlock?.content === "string") {
        const contentOk = readToolResultOkValue(recordBlock.content);
        if (contentOk !== undefined) {
          return contentOk;
        }
      }
    }
  }
  return undefined;
}

function hasDryRunToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record && isDryRunMessageToolRecord(record)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasDryRunToolResultValue(block)) {
      return true;
    }
    const recordBlock = readRecord(block);
    if (typeof recordBlock?.text === "string" && hasDryRunToolResultValue(recordBlock.text)) {
      return true;
    }
    return (
      typeof recordBlock?.content === "string" && hasDryRunToolResultValue(recordBlock.content)
    );
  });
}

function isSuccessfulMessageToolResult(
  message: Record<string, unknown>,
  pending: PendingMessageToolVisibleReply,
): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase().replace(/_/g, "") : "";
  const toolName = readMessageToolResultName(message)?.toLowerCase();
  if (role !== "toolresult" && role !== "tool" && role !== "function" && toolName !== "message") {
    return false;
  }
  if (toolName && toolName !== "message") {
    return false;
  }
  const resultCallId = readMessageToolResultCallId(message);
  if (pending.toolCallId) {
    return resultCallId === pending.toolCallId && isSuccessfulMessageToolResultPayload(message);
  }
  return isSuccessfulMessageToolResultPayload(message);
}

function isSuccessfulMessageToolResultPayload(message: Record<string, unknown>): boolean {
  if (message.isError === true || (message.error != null && message.error !== false)) {
    return false;
  }
  if (
    hasDryRunToolResultValue(message.result) ||
    hasDryRunToolResultValue(message.output) ||
    hasDryRunToolResultValue(message.content) ||
    hasDryRunToolResultValue(message.text)
  ) {
    return false;
  }
  const ok =
    readToolResultOkValue(message.result) ??
    readToolResultOkValue(message.output) ??
    readToolResultOkValue(message.content) ??
    readToolResultOkValue(message.text);
  return ok !== false;
}

function buildMessageToolVisibleReplyMirror(
  pending: PendingMessageToolVisibleReply,
): Record<string, unknown> {
  const mirror: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: pending.text }],
    openclawMessageToolMirror: {
      toolName: "message",
      ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
    },
  };
  for (const field of ["timestamp", "createdAt", "agentId"] as const) {
    if (pending.anchor[field] !== undefined) {
      mirror[field] = pending.anchor[field];
    }
  }
  const transcriptMeta = readRecord((pending.completionAnchor ?? pending.anchor)["__openclaw"]);
  if (transcriptMeta) {
    mirror["__openclaw"] = { ...transcriptMeta };
  }
  return mirror;
}

function mirrorMessageToolVisibleReplies(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  if (!messages.some((message) => readRecord(message))) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  const pending: PendingMessageToolVisibleReply[] = [];

  const clearPending = () => {
    if (pending.length > 0) {
      pending.length = 0;
    }
  };

  const flushSucceededMirrors = () => {
    for (const item of pending) {
      if (!item.succeeded) {
        continue;
      }
      next.push(buildMessageToolVisibleReplyMirror(item));
      changed = true;
    }
    clearPending();
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const record = readRecord(message);
    if (!record) {
      next.push(message);
      continue;
    }

    if (record.role === "user") {
      clearPending();
      next.push(message);
      continue;
    }

    const visibleReplies = extractMessageToolVisibleReplies(record);
    if (visibleReplies.length > 0) {
      for (const reply of visibleReplies) {
        pending.push({
          ...reply,
          anchor: record,
          succeeded: false,
        });
      }
    } else if (isRenderableAssistantDisplayMessage(record)) {
      clearPending();
    }

    if (pending.length > 0) {
      for (const item of pending) {
        if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
          item.succeeded = true;
          item.completionAnchor = record;
        }
      }
      if (isAssistantSilentControlReplyOnly(record)) {
        flushSucceededMirrors();
      }
    }

    next.push(message);
  }

  return changed ? next : messages;
}

function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return !hasAssistantMixedToolVisibleText(message);
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (text === undefined || !isSuppressedControlReplyText(text)) {
    return false;
  }
  return !hasAssistantNonTextContent(message);
}

export function sanitizeChatHistoryMessages(
  messages: unknown[],
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    if (shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function asRoleContentMessage(message: Record<string, unknown>): RoleContentMessage | null {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (!role) {
    return null;
  }
  return {
    role,
    ...(message.content !== undefined
      ? { content: message.content }
      : message.text !== undefined
        ? { content: message.text }
        : {}),
  };
}

function isEmptyTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string" || entry.text.trim().length > 0) {
      return false;
    }
  }
  return sawText;
}

function hasTranscriptMediaPaths(message: Record<string, unknown>): boolean {
  const mediaPaths = Array.isArray(message.MediaPaths)
    ? message.MediaPaths
    : typeof message.MediaPath === "string"
      ? [message.MediaPath]
      : [];
  return mediaPaths.some((value) => typeof value === "string" && value.trim());
}

function extractProjectedText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function digestTtsSupplementText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function readTtsSupplementMarker(
  message: Record<string, unknown>,
): { textSha256?: string; spokenText?: string } | undefined {
  const marker = message.openclawTtsSupplement;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return undefined;
  }
  const entry = marker as { textSha256?: unknown; spokenText?: unknown };
  const textSha256 =
    typeof entry.textSha256 === "string" && entry.textSha256.trim()
      ? entry.textSha256.trim()
      : undefined;
  const spokenText =
    typeof entry.spokenText === "string" && entry.spokenText.trim()
      ? entry.spokenText.trim()
      : undefined;
  return textSha256 || spokenText ? { textSha256, spokenText } : undefined;
}

function isAssistantTtsSupplementMessage(message: Record<string, unknown>): boolean {
  if (asRoleContentMessage(message)?.role !== "assistant") {
    return false;
  }
  if (!readTtsSupplementMarker(message)) {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasSupplementBlock = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      hasSupplementBlock = true;
      continue;
    }
    const text =
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text.trim()
        : "";
    if (text && text !== "Audio reply") {
      return false;
    }
  }
  return hasSupplementBlock;
}

function ttsSupplementMatchesAssistant(
  marker: { textSha256?: string; spokenText?: string },
  message: Record<string, unknown>,
): boolean {
  if (asRoleContentMessage(message)?.role !== "assistant") {
    return false;
  }
  if (readTtsSupplementMarker(message)) {
    return false;
  }
  const text = extractProjectedText(message.content ?? message.text).trim();
  if (!text) {
    return false;
  }
  if (marker.textSha256 && digestTtsSupplementText(text) === marker.textSha256) {
    return true;
  }
  return Boolean(marker.spokenText && text === marker.spokenText);
}

function mergeTtsSupplementContent(
  target: Record<string, unknown>,
  supplement: Record<string, unknown>,
): Record<string, unknown> {
  const supplementBlocks = Array.isArray(supplement.content)
    ? supplement.content.filter(
        (block) =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type !== "text",
      )
    : [];
  if (supplementBlocks.length === 0) {
    return target;
  }
  const targetContent = target.content;
  if (Array.isArray(targetContent)) {
    return { ...target, content: [...targetContent, ...supplementBlocks] };
  }
  const targetText = extractProjectedText(targetContent ?? target.text).trim();
  return {
    ...target,
    content: [...(targetText ? [{ type: "text", text: targetText }] : []), ...supplementBlocks],
  };
}

function mergeTtsSupplementMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!messages.some(isAssistantTtsSupplementMessage)) {
    return messages;
  }
  const merged: Array<Record<string, unknown>> = [];
  let changed = false;
  for (const message of messages) {
    const marker = readTtsSupplementMarker(message);
    if (marker && isAssistantTtsSupplementMessage(message)) {
      let targetIndex = -1;
      for (let i = merged.length - 1; i >= 0; i--) {
        if (ttsSupplementMatchesAssistant(marker, merged[i])) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        merged[targetIndex] = mergeTtsSupplementContent(merged[targetIndex], message);
        changed = true;
        continue;
      }
    }
    merged.push(message);
  }
  return changed ? merged : messages;
}

function isSubagentAnnounceInterSessionUserMessage(message: Record<string, unknown>): boolean {
  const provenance = normalizeInputProvenance(message.provenance);
  if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    return true;
  }
  const text = extractProjectedText(message.content ?? message.text);
  return (
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) && text.includes("sourceTool=subagent_announce")
  );
}

function isDisplayHiddenProjectedMessage(message: Record<string, unknown>): boolean {
  if (message.display === false) {
    return true;
  }
  return message.role === "custom" && message.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE;
}

function shouldHideProjectedHistoryMessage(message: Record<string, unknown>): boolean {
  if (isDisplayHiddenProjectedMessage(message)) {
    return true;
  }
  const roleContent = asRoleContentMessage(message);
  if (!roleContent) {
    return false;
  }
  if (roleContent.role === "user" && isSubagentAnnounceInterSessionUserMessage(message)) {
    return true;
  }
  if (
    roleContent.role === "user" &&
    isEmptyTextOnlyContent(message.content ?? message.text) &&
    !hasTranscriptMediaPaths(message)
  ) {
    return true;
  }
  if (roleContent.role === "assistant" && isEmptyTextOnlyContent(message.content ?? message.text)) {
    return false;
  }
  if (isHeartbeatUserMessage(roleContent, HEARTBEAT_PROMPT)) {
    return true;
  }
  return isHeartbeatOkResponse(roleContent);
}

function openclawAssistantModel(message: Record<string, unknown>): string | undefined {
  return message.role === "assistant" &&
    message.provider === "openclaw" &&
    typeof message.model === "string"
    ? message.model
    : undefined;
}

function displayTextForDuplicateCheck(message: Record<string, unknown>): string | undefined {
  const text = extractProjectedText(message.content ?? message.text).trim();
  return text ? text : undefined;
}

function isDuplicateAcpGatewayInjectedMessage(
  current: Record<string, unknown>,
  previousVisible: Record<string, unknown> | undefined,
): boolean {
  if (!previousVisible) {
    return false;
  }
  if (
    openclawAssistantModel(previousVisible) !== "acp-runtime" ||
    openclawAssistantModel(current) !== "gateway-injected"
  ) {
    return false;
  }
  if (hasAssistantNonTextContent(previousVisible) || hasAssistantNonTextContent(current)) {
    return false;
  }
  const previousText = displayTextForDuplicateCheck(previousVisible);
  const currentText = displayTextForDuplicateCheck(current);
  return Boolean(previousText && currentText && previousText === currentText);
}

function toProjectedMessages(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
}

function filterVisibleProjectedHistoryMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const visible: Array<Record<string, unknown>> = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) {
      continue;
    }
    const currentRoleContent = asRoleContentMessage(current);
    const next = messages[i + 1];
    const nextRoleContent = next ? asRoleContentMessage(next) : null;
    if (
      currentRoleContent &&
      nextRoleContent &&
      isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT) &&
      isHeartbeatOkResponse(nextRoleContent)
    ) {
      changed = true;
      i++;
      continue;
    }
    if (shouldHideProjectedHistoryMessage(current)) {
      changed = true;
      continue;
    }
    if (isDuplicateAcpGatewayInjectedMessage(current, visible.at(-1))) {
      changed = true;
      continue;
    }
    visible.push(current);
  }
  return changed ? visible : messages;
}

export function projectChatDisplayMessages(
  messages: unknown[],
  options?: { maxChars?: number; stripEnvelope?: boolean },
): Array<Record<string, unknown>> {
  const source = options?.stripEnvelope === false ? messages : stripEnvelopeFromMessages(messages);
  const mirrored = mirrorMessageToolVisibleReplies(source);
  const merged = mergeTtsSupplementMessages(
    filterVisibleProjectedHistoryMessages(
      toProjectedMessages(sanitizeChatHistoryMessages(mirrored, Number.MAX_SAFE_INTEGER)),
    ),
  );
  return sanitizeChatHistoryMessages(
    merged,
    options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  ) as Array<Record<string, unknown>>;
}

function limitChatDisplayMessages<T>(messages: T[], maxMessages?: number): T[] {
  if (
    typeof maxMessages !== "number" ||
    !Number.isFinite(maxMessages) ||
    maxMessages <= 0 ||
    messages.length <= maxMessages
  ) {
    return messages;
  }
  return messages.slice(-Math.floor(maxMessages));
}

export function projectRecentChatDisplayMessages(
  messages: unknown[],
  options?: { maxChars?: number; maxMessages?: number; stripEnvelope?: boolean },
): Array<Record<string, unknown>> {
  return limitChatDisplayMessages(
    projectChatDisplayMessages(messages, options),
    options?.maxMessages,
  );
}

export function projectChatDisplayMessage(
  message: unknown,
  options?: { maxChars?: number; stripEnvelope?: boolean },
): Record<string, unknown> | undefined {
  return projectChatDisplayMessages([message], options)[0];
}
