// Gateway chat display projection.
// Converts raw transcript messages into bounded Control UI/history display records.
import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import {
  asFiniteNumber,
  asPositiveSafeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../agents/internal-runtime-context.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { extractCanvasFromDetails, extractCanvasFromText } from "../chat/canvas-render.js";
import {
  INTER_SESSION_PROMPT_PREFIX_BASE,
  normalizeInputProvenance,
  stripInterSessionPromptPrefixForDisplay,
} from "../sessions/input-provenance.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
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
  deliveryMirrorAnchor?: Record<string, unknown>;
  deliveryMirrorIndex?: number;
  sourceReplySink?: "internal-ui";
  succeeded: boolean;
};

/** Resolve the text cap used when projecting chat history for display. */
export function resolveEffectiveChatHistoryMaxChars(_cfg: unknown, maxChars?: number): number {
  if (typeof maxChars === "number") {
    return maxChars;
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
    text: `${truncateUtf16Safe(text, maxChars)}\n...(truncated)...`,
    truncated: true,
  };
}

/** Return true for known tool-call/tool-result block type spellings in transcripts. */
function isToolHistoryBlockType(type: unknown): boolean {
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

function isToolResultHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return normalized === "toolresult" || normalized === "tool_result";
}

function projectToolResultDetails(
  details: unknown,
  maxChars: number,
): Record<string, unknown> | undefined {
  const record = readRecord(details);
  if (!record) {
    return undefined;
  }
  const projected: Record<string, unknown> = {};
  if (typeof record.diff === "string" && record.diff.trim()) {
    projected.diff = truncateChatHistoryText(record.diff, maxChars).text;
  }
  const preview = extractCanvasFromDetails(record);
  if (preview?.mcpApp && preview.viewId) {
    projected.mcpAppPreview = {
      kind: "canvas",
      view: {
        id: preview.viewId,
        ...(preview.url ? { url: preview.url } : {}),
        ...(preview.title ? { title: preview.title } : {}),
      },
      presentation: {
        target: "assistant_message",
        ...(preview.title ? { title: preview.title } : {}),
        ...(preview.preferredHeight ? { preferred_height: preview.preferredHeight } : {}),
        ...(preview.sandbox ? { sandbox: preview.sandbox } : {}),
      },
      mcpApp: preview.mcpApp,
    };
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function messageHasToolResultShape(message: Record<string, unknown>): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role === "toolresult" || role === "tool_result" || role === "tool" || role === "function") {
    return true;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (
    content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        isToolResultHistoryBlockType((block as { type?: unknown }).type),
    )
  ) {
    return true;
  }
  const hasToolCallBlock = content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      isToolHistoryBlockType((block as { type?: unknown }).type) &&
      !isToolResultHistoryBlockType((block as { type?: unknown }).type),
  );
  const hasToolId =
    typeof message.toolCallId === "string" ||
    typeof message.tool_call_id === "string" ||
    typeof message.toolUseId === "string" ||
    typeof message.tool_use_id === "string";
  const hasToolName = typeof message.toolName === "string" || typeof message.tool_name === "string";
  return hasToolId && hasToolName && !hasToolCallBlock;
}

function extractChatHistoryBlockText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const textParts = entry.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return undefined;
      }
      const typed = block as { text?: unknown };
      return typeof typed.text === "string" ? typed.text : undefined;
    })
    .filter((value): value is string => typeof value === "string");
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractChatHistoryCanvasPreview(message: Record<string, unknown>) {
  const direct = extractCanvasFromDetails(message.details);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  for (const block of message.content) {
    const preview = extractCanvasFromDetails(readRecord(block)?.details);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

function appendCanvasBlockToAssistantHistoryMessage(params: {
  message: unknown;
  preview: ReturnType<typeof extractCanvasFromText>;
  rawText: string | null;
}): unknown {
  const preview = params.preview;
  if (!preview || !params.message || typeof params.message !== "object") {
    return params.message;
  }
  const entry = params.message as Record<string, unknown>;
  const baseContent = Array.isArray(entry.content)
    ? [...entry.content]
    : typeof entry.content === "string"
      ? [{ type: "text", text: entry.content }]
      : typeof entry.text === "string"
        ? [{ type: "text", text: entry.text }]
        : [];
  const alreadyPresent = baseContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as { type?: unknown; preview?: unknown };
    return (
      typed.type === "canvas" &&
      typed.preview &&
      typeof typed.preview === "object" &&
      (((typed.preview as { viewId?: unknown }).viewId &&
        (typed.preview as { viewId?: unknown }).viewId === preview.viewId) ||
        ((typed.preview as { url?: unknown }).url &&
          (typed.preview as { url?: unknown }).url === preview.url))
    );
  });
  if (!alreadyPresent) {
    baseContent.push({
      type: "canvas",
      preview,
      rawText: params.rawText,
    });
  }
  return {
    ...entry,
    content: baseContent,
  };
}

function messageContainsToolHistoryContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string"
  ) {
    return true;
  }
  if (!Array.isArray(entry.content)) {
    return false;
  }
  return entry.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
}

export function augmentChatHistoryWithCanvasBlocks(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  const next = [...messages];
  let changed = false;
  let lastAssistantIndex = -1;
  let lastRenderableAssistantIndex = -1;
  const pending: Array<{
    preview: NonNullable<ReturnType<typeof extractCanvasFromText>>;
    rawText: string | null;
  }> = [];
  for (let index = 0; index < next.length; index++) {
    const message = next[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    if (role === "assistant") {
      lastAssistantIndex = index;
      if (!messageContainsToolHistoryContent(entry)) {
        lastRenderableAssistantIndex = index;
        if (pending.length > 0) {
          let target = next[index];
          for (const item of pending) {
            target = appendCanvasBlockToAssistantHistoryMessage({
              message: target,
              preview: item.preview,
              rawText: item.rawText,
            });
          }
          next[index] = target;
          pending.length = 0;
          changed = true;
        }
      }
      continue;
    }
    if (!messageContainsToolHistoryContent(entry)) {
      continue;
    }
    const toolName =
      typeof entry.toolName === "string"
        ? entry.toolName
        : typeof entry.tool_name === "string"
          ? entry.tool_name
          : undefined;
    const text = extractChatHistoryBlockText(entry);
    const detailsPreview = extractChatHistoryCanvasPreview(entry);
    const preview = detailsPreview ?? extractCanvasFromText(text, toolName);
    if (!preview) {
      continue;
    }
    pending.push({
      preview,
      rawText: detailsPreview ? null : (text ?? null),
    });
  }
  if (pending.length > 0) {
    const targetIndex =
      lastRenderableAssistantIndex >= 0 ? lastRenderableAssistantIndex : lastAssistantIndex;
    if (targetIndex >= 0) {
      let target = next[targetIndex];
      for (const item of pending) {
        target = appendCanvasBlockToAssistantHistoryMessage({
          message: target,
          preview: item.preview,
          rawText: item.rawText,
        });
      }
      next[targetIndex] = target;
      changed = true;
    }
  }
  return changed ? next : messages;
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
  if (isToolResultHistoryBlockType(entry.type) && "details" in entry) {
    const projectedDetails = projectToolResultDetails(entry.details, maxChars);
    if (projectedDetails) {
      entry.details = projectedDetails;
    } else {
      delete entry.details;
    }
    changed = true;
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
  return asFiniteNumber(x);
}

function sanitizeCost(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const value = toFiniteNumber(c[key]);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    const projectedDetails = messageHasToolResultShape(entry)
      ? projectToolResultDetails(entry.details, maxChars)
      : undefined;
    if (projectedDetails) {
      entry.details = projectedDetails;
    } else {
      delete entry.details;
    }
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
    if (!isAssistantTextContentType(typed.type) || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function isAssistantTextContentType(type: unknown): boolean {
  return type === "text" || type === "input_text" || type === "output_text";
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
    (block) =>
      block &&
      typeof block === "object" &&
      !isAssistantTextContentType((block as { type?: unknown }).type),
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
    if (
      isAssistantTextContentType(entry.type) &&
      typeof entry.text === "string" &&
      entry.text.trim()
    ) {
      hasText = true;
    }
  }
  return hasToolHistoryBlock && hasText;
}

function normalizeToolHistoryType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ? normalized.replace(/_/g, "") : undefined;
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

function readMessageToolSourceReplySink(
  message: Record<string, unknown>,
): "internal-ui" | undefined {
  const details = readRecord(message.details);
  return details?.sourceReplySink === "internal-ui" ? "internal-ui" : undefined;
}

function buildMessageToolVisibleReplyMirror(
  pending: PendingMessageToolVisibleReply,
): Record<string, unknown> {
  const sourceMessageSeq = asPositiveSafeInteger(readRecord(pending.anchor["__openclaw"])?.seq);
  const mirror: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: pending.text }],
    openclawMessageToolMirror: {
      toolName: "message",
      ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
      ...(pending.sourceReplySink ? { sourceReplySink: pending.sourceReplySink } : {}),
      ...(pending.sourceReplySink && sourceMessageSeq ? { sourceMessageSeq } : {}),
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

function readMessageToolDeliveryMirrorText(message: Record<string, unknown>): string | undefined {
  // Delivery mirrors can arrive between a successful message-tool result and
  // the final NO_REPLY. The pending mirror is the display row; the raw mirror
  // would duplicate that same send.
  if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
    return undefined;
  }
  return displayTextForDuplicateCheck(message);
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

  const flushSelectedMirrors = (items: PendingMessageToolVisibleReply[]) => {
    if (items.length === 0) {
      return;
    }
    const selected = new Set(items);
    const remaining: PendingMessageToolVisibleReply[] = [];
    for (const item of pending) {
      if (selected.has(item) && item.succeeded) {
        next.push(buildMessageToolVisibleReplyMirror(item));
        changed = true;
        continue;
      }
      remaining.push(item);
    }
    pending.length = 0;
    pending.push(...remaining);
  };

  for (const message of messages) {
    const record = readRecord(message);
    if (!record) {
      next.push(message);
      continue;
    }

    if (
      (record.role === "user" && isSessionsSendInterSessionUserMessage(record)) ||
      isProjectedSessionsSendForwardedMessage(record)
    ) {
      next.push(message);
      continue;
    }

    if (record.role === "user") {
      clearPending();
      next.push(message);
      continue;
    }

    const flushAfterCurrentMessage: PendingMessageToolVisibleReply[] = [];
    const deliveryMirrorText = readMessageToolDeliveryMirrorText(record);
    const matchingDeliveryMirrorPending = deliveryMirrorText
      ? pending.filter((item) => item.text.trim() === deliveryMirrorText)
      : [];
    const duplicateDeliveryMirror = matchingDeliveryMirrorPending.some((item) => item.succeeded);
    const visibleReplies = extractMessageToolVisibleReplies(record);
    if (visibleReplies.length > 0) {
      for (const reply of visibleReplies) {
        pending.push({
          ...reply,
          anchor: record,
          succeeded: false,
        });
      }
    } else if (
      matchingDeliveryMirrorPending.length === 0 &&
      isRenderableAssistantDisplayMessage(record)
    ) {
      clearPending();
    }

    if (pending.length > 0) {
      for (const item of pending) {
        if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
          item.succeeded = true;
          const sourceReplySink = readMessageToolSourceReplySink(record);
          if (sourceReplySink) {
            item.sourceReplySink = sourceReplySink;
          }
          item.completionAnchor = item.deliveryMirrorAnchor ?? record;
          if (item.deliveryMirrorAnchor) {
            if (typeof item.deliveryMirrorIndex === "number") {
              next[item.deliveryMirrorIndex] = { ...item.deliveryMirrorAnchor, display: false };
            }
            flushAfterCurrentMessage.push(item);
          }
        }
      }
      if (isAssistantSilentControlReplyOnly(record)) {
        flushSucceededMirrors();
      }
    }

    if (duplicateDeliveryMirror) {
      for (const item of matchingDeliveryMirrorPending) {
        item.completionAnchor = record;
      }
      flushSelectedMirrors(matchingDeliveryMirrorPending);
      changed = true;
      continue;
    }

    for (const item of matchingDeliveryMirrorPending) {
      item.deliveryMirrorAnchor = record;
      item.deliveryMirrorIndex = next.length;
    }
    next.push(message);
    flushSelectedMirrors(flushAfterCurrentMessage);
  }

  return changed ? next : messages;
}

function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown> & { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (isProjectedSessionsSendForwardedMessage(entry)) {
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
  if (isProjectedSessionsSendForwardedMessage(message)) {
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
        const candidate = merged[i];
        if (candidate && ttsSupplementMatchesAssistant(marker, candidate)) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        merged[targetIndex] = mergeTtsSupplementContent(
          expectDefined(merged[targetIndex], "merged entry at target index"),
          message,
        );
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

function readChatHistoryRecordTimestampMs(message: unknown): number | undefined {
  const meta = readRecord(readRecord(message)?.["__openclaw"]);
  const value = meta?.recordTimestampMs;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const timestamp = readRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function isSubagentAnnounceInterSessionUserChatHistoryMessage(message: unknown): boolean {
  const record = readRecord(message);
  if (!record || record.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(record.provenance);
  if (provenance?.kind === "inter_session" && provenance.sourceTool === "subagent_announce") {
    return true;
  }
  const text = extractChatHistoryBlockText(record);
  return (
    typeof text === "string" &&
    text.includes(INTER_SESSION_PROMPT_PREFIX_BASE) &&
    text.includes("sourceTool=subagent_announce")
  );
}

function isChatHistoryAssistantMessage(message: unknown): boolean {
  return readRecord(message)?.role === "assistant";
}

export function dropPreSessionStartAnnouncePairs(
  messages: unknown[],
  sessionStartedAt: number | undefined,
): unknown[] {
  if (sessionStartedAt === undefined || messages.length === 0) {
    return messages;
  }
  let changed = false;
  const kept: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (isSubagentAnnounceInterSessionUserChatHistoryMessage(current)) {
      const ts = readChatHistoryRecordTimestampMs(current);
      if (typeof ts === "number" && ts < sessionStartedAt) {
        const next = messages[i + 1];
        const nextTs = readChatHistoryRecordTimestampMs(next);
        if (
          isChatHistoryAssistantMessage(next) &&
          typeof nextTs === "number" &&
          nextTs < sessionStartedAt
        ) {
          // Skip only an assistant reply that is also pre-session-start; recent
          // or timestampless assistants may be real fresh-session context.
          i++;
        }
        changed = true;
        continue;
      }
    }
    kept.push(current);
  }
  return changed ? kept : messages;
}

function isSessionsSendInterSessionUserMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(message.provenance);
  return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
}

function isProjectedSessionsSendForwardedMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const provenance = normalizeInputProvenance(message.provenance);
  return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
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
  if (isProjectedSessionsSendForwardedMessage(message)) {
    return false;
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

function isDuplicateChannelFinalDeliveryMirror(
  current: Record<string, unknown>,
  previousVisible: Record<string, unknown> | undefined,
): boolean {
  if (!previousVisible || !isOpenClawDeliveryMirrorAssistantMessage(current)) {
    return false;
  }
  const deliveryMirror = readRecord(current.openclawDeliveryMirror);
  if (deliveryMirror?.kind !== "channel-final") {
    return false;
  }
  if (asRoleContentMessage(previousVisible)?.role !== "assistant") {
    return false;
  }
  if (isOpenClawDeliveryMirrorAssistantMessage(previousVisible)) {
    return false;
  }
  if (isProjectedSessionsSendForwardedMessage(previousVisible)) {
    return false;
  }
  const previousMeta = readRecord(previousVisible["__openclaw"]);
  if (typeof previousMeta?.mirrorIdentity !== "string" || !previousMeta.mirrorIdentity.trim()) {
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
      next &&
      nextRoleContent &&
      isHeartbeatUserMessage(currentRoleContent, HEARTBEAT_PROMPT) &&
      isHeartbeatOkResponse(nextRoleContent) &&
      !isProjectedSessionsSendForwardedMessage(next)
    ) {
      changed = true;
      i++;
      continue;
    }
    if (shouldHideProjectedHistoryMessage(current)) {
      changed = true;
      continue;
    }
    if (
      isDuplicateAcpGatewayInjectedMessage(current, visible.at(-1)) ||
      isDuplicateChannelFinalDeliveryMirror(current, messages[i - 1])
    ) {
      changed = true;
      continue;
    }
    visible.push(current);
  }
  return changed ? visible : messages;
}

function stripInterSessionPromptPrefixFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripInterSessionPromptPrefixForDisplay(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return block;
    }
    const record = block as Record<string, unknown>;
    if (typeof record.text !== "string") {
      return block;
    }
    const stripped = stripInterSessionPromptPrefixForDisplay(record.text);
    return stripped === record.text ? block : { ...record, text: stripped };
  });
}

function extractPromptPrefixField(text: string, field: string): string | undefined {
  const prefixIndex = text.indexOf(INTER_SESSION_PROMPT_PREFIX_BASE);
  if (prefixIndex === -1) {
    return undefined;
  }
  const lineEnd = text.indexOf("\n", prefixIndex);
  const header = lineEnd === -1 ? text.slice(prefixIndex) : text.slice(prefixIndex, lineEnd);
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escapedField}=([^\\s]+)`).exec(header);
  return normalizeOptionalString(match?.[1]);
}

function resolveSessionsSendForwardedSenderLabel(message: Record<string, unknown>): string {
  const provenance = normalizeInputProvenance(message.provenance);
  const text = extractProjectedText(message.content ?? message.text);
  const sourceSessionKey =
    provenance?.sourceSessionKey ?? extractPromptPrefixField(text, "sourceSession");
  const agentId = parseAgentSessionKey(sourceSessionKey)?.agentId;
  return agentId ? `Forwarded from ${agentId}` : "Forwarded agent message";
}

function projectSessionsSendInterSessionMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = messages.map((message) => {
    if (!isSessionsSendInterSessionUserMessage(message)) {
      return message;
    }
    changed = true;
    const next: Record<string, unknown> = {
      ...message,
      role: "assistant",
      senderLabel: resolveSessionsSendForwardedSenderLabel(message),
    };
    if ("content" in next) {
      next.content = stripInterSessionPromptPrefixFromContent(next.content);
    }
    if (typeof next.text === "string") {
      next.text = stripInterSessionPromptPrefixForDisplay(next.text);
    }
    return next;
  });
  return changed ? projected : messages;
}

const GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT = "The agent run failed before producing a reply.";

function sanitizeAssistantErrorDisplayMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const { content, ...envelope } = message;
  const next = sanitizeChatHistoryMessage(envelope, Number.MAX_SAFE_INTEGER).message as Record<
    string,
    unknown
  >;
  next.content = Array.isArray(content)
    ? content
        .map(
          (block) =>
            sanitizeChatHistoryContentBlock(block, { maxChars: Number.MAX_SAFE_INTEGER }).block,
        )
        .filter((block) => {
          if (!block || typeof block !== "object" || Array.isArray(block)) {
            return true;
          }
          const type = (block as { type?: unknown }).type;
          return type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";
        })
    : content;
  delete next.diagnostics;
  delete next.errorBody;
  delete next.errorCode;
  delete next.errorMessage;
  delete next.errorType;
  return next;
}

function projectEmptyAssistantErrorMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = messages.map((message) => {
    if (message.role !== "assistant" || message.stopReason !== "error") {
      return message;
    }
    const hasDisplayableStructuredContent =
      Array.isArray(message.content) &&
      message.content.some((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          return false;
        }
        const type = (block as { type?: unknown }).type;
        return (
          !isAssistantTextContentType(type) &&
          type !== "thinking" &&
          type !== "reasoning" &&
          type !== "redacted_thinking"
        );
      });
    if (hasDisplayableStructuredContent) {
      changed = true;
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER)
      .message as Record<string, unknown>;
    const visibleTexts: string[] = [];
    if (typeof sanitized.content === "string") {
      visibleTexts.push(sanitized.content);
    } else if (Array.isArray(sanitized.content)) {
      for (const block of sanitized.content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          continue;
        }
        const entry = block as { type?: unknown; text?: unknown };
        if (isAssistantTextContentType(entry.type) && typeof entry.text === "string") {
          visibleTexts.push(entry.text);
        }
      }
    }
    if (typeof sanitized.text === "string") {
      visibleTexts.push(sanitized.text);
    }
    const nonEmptyVisibleTexts = visibleTexts.map((text) => text.trim()).filter(Boolean);
    const hasVisibleReplyText = nonEmptyVisibleTexts.some(
      (text) => text !== STREAM_ERROR_FALLBACK_TEXT && !isSuppressedControlReplyText(text),
    );
    if (!shouldDropAssistantHistoryMessage(sanitized) && hasVisibleReplyText) {
      changed = true;
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    changed = true;
    const next: Record<string, unknown> = {
      ...sanitized,
      content: [{ type: "text", text: GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT }],
    };
    delete next.diagnostics;
    delete next.errorBody;
    delete next.errorCode;
    delete next.errorMessage;
    delete next.errorType;
    delete next.phase;
    delete next.text;
    return next;
  });
  return changed ? projected : messages;
}

export function projectChatDisplayMessages(
  messages: unknown[],
  options?: { maxChars?: number; stripEnvelope?: boolean },
): Array<Record<string, unknown>> {
  const source = options?.stripEnvelope === false ? messages : stripEnvelopeFromMessages(messages);
  const mirrored = mirrorMessageToolVisibleReplies(source);
  const projectedErrors = projectEmptyAssistantErrorMessages(toProjectedMessages(mirrored));
  const projectedForwarded = mergeTtsSupplementMessages(
    filterVisibleProjectedHistoryMessages(
      projectSessionsSendInterSessionMessages(
        toProjectedMessages(sanitizeChatHistoryMessages(projectedErrors, Number.MAX_SAFE_INTEGER)),
      ),
    ),
  );
  return sanitizeChatHistoryMessages(
    projectedForwarded,
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
