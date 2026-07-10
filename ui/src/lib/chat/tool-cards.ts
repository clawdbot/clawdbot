import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI chat domain owns pure tool-card extraction rules.
import { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import type { ToolCard, ToolCardOutcome } from "./chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;

function resolveTranscriptMessageId(message: Record<string, unknown>): string | undefined {
  if (typeof message.messageId === "string" && message.messageId.trim()) {
    return message.messageId;
  }
  const openClawMeta = message["__openclaw"];
  const transcriptMeta =
    openClawMeta && typeof openClawMeta === "object" && !Array.isArray(openClawMeta)
      ? (openClawMeta as Record<string, unknown>)
      : null;
  return typeof transcriptMeta?.id === "string" && transcriptMeta.id.trim()
    ? transcriptMeta.id
    : undefined;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
  );
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const parts = item.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) {
    return false;
  }
  const trimmed = outputText.trim();
  if (!trimmed) {
    return false;
  }
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length > MAX_ERROR_DETECT_CHARS) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  const explicitErrorFlag = readToolErrorFlag(obj);
  if (explicitErrorFlag !== undefined) {
    return explicitErrorFlag;
  }
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value && typeof value === "object") {
      return true;
    }
  }
  return hasToolErrorStatus(obj.status);
}

export function isToolCardError(card: ToolCard): boolean {
  if (card.isError !== undefined) {
    return card.isError;
  }
  return isToolErrorOutput(card.outputText);
}

export function resolveToolCardOutcome(
  card: ToolCard,
  runActive: boolean | undefined,
): ToolCardOutcome {
  if (isToolCardError(card)) {
    return "failed";
  }
  if (runActive === true && card.live === true && card.completed !== true) {
    return "running";
  }
  if (card.completed === true || (card.live !== true && card.outputText !== undefined)) {
    return "succeeded";
  }
  return "unknown";
}

export function extractToolPreview(
  outputText: string | undefined,
  toolName: string | undefined,
): ToolCard["preview"] | undefined {
  return extractCanvasFromText(outputText, toolName);
}

function resolveToolCallId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return (
    resolveToolUseId(item) ||
    (typeof item.callId === "string" && item.callId.trim()) ||
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
    (typeof message.toolUseId === "string" && message.toolUseId.trim()) ||
    (typeof message.tool_use_id === "string" && message.tool_use_id.trim()) ||
    undefined
  );
}

function resolveToolName(item: Record<string, unknown>, message: Record<string, unknown>): string {
  return (
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    "tool"
  );
}

function resolveToolCardId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  index: number,
  prefix = "tool",
): string {
  const explicitId = resolveToolCallId(item, message);
  if (explicitId) {
    return `${prefix}:${explicitId}`;
  }
  const name = resolveToolName(item, message);
  return `${prefix}:${name}:${index}`;
}

function serializeToolInput(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    if (typeof args === "number" || typeof args === "boolean" || typeof args === "bigint") {
      return String(args);
    }
    if (typeof args === "symbol") {
      return args.description ? `Symbol(${args.description})` : "Symbol()";
    }
    return Object.prototype.toString.call(args);
  }
}

export function formatCollapsedToolSummaryText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  const withoutConnector = normalized.replace(/^with\s+/i, "").trim();
  return withoutConnector || normalized;
}

function collapsedToolTextKey(value: string | undefined): string | undefined {
  return formatCollapsedToolSummaryText(value)
    ?.toLowerCase()
    .replace(/[\s._-]+/g, "");
}

export function formatDistinctCollapsedToolSummaryText(
  value: string | undefined,
  label: string | undefined,
): string | undefined {
  const displayValue = formatCollapsedToolSummaryText(value);
  if (!displayValue) {
    return undefined;
  }
  const valueKey = collapsedToolTextKey(displayValue);
  const labelKey = collapsedToolTextKey(label);
  return valueKey && labelKey && valueKey === labelKey ? undefined : displayValue;
}

export function formatCollapsedToolPreviewText(value: string | undefined): string | undefined {
  const normalized = formatCollapsedToolSummaryText(value);
  if (!normalized) {
    return undefined;
  }
  return truncateUtf16Safe(normalized, 120);
}

function findFirstUnmatchedCard(
  cards: ToolCard[],
  id: string,
  name: string,
  fallbackMatchedCards: WeakSet<ToolCard>,
): ToolCard | undefined {
  let nameOnlyCandidate: ToolCard | undefined;
  for (const card of cards) {
    if (card.id === id) {
      return card;
    }
    if (
      !nameOnlyCandidate &&
      card.name === name &&
      card.outputText === undefined &&
      !fallbackMatchedCards.has(card)
    ) {
      nameOnlyCandidate = card;
    }
  }
  return nameOnlyCandidate;
}

export function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const messageIsError = readToolErrorFlag(m);
  const isLiveToolStream = m["__openclawToolStreamLive"] === true;
  const cards: ToolCard[] = [];
  const fallbackMatchedCards = new WeakSet<ToolCard>();
  const transcriptMessageId = resolveTranscriptMessageId(m);

  for (let index = 0; index < content.length; index++) {
    const item = content[index] ?? {};
    const isToolCall =
      isToolCallContentType(item.type) ||
      (typeof item.name === "string" &&
        (item.arguments != null || item.args != null || item.input != null));
    if (isToolCall) {
      const args = coerceArgs(item.arguments ?? item.args ?? item.input);
      const callId = resolveToolCallId(item, m);
      cards.push({
        id: resolveToolCardId(item, m, index, prefix),
        ...(callId ? { callId } : {}),
        name: resolveToolName(item, m),
        args,
        inputText: serializeToolInput(args),
        ...(isLiveToolStream
          ? { live: true, completed: m["__openclawToolStreamResultReceived"] === true }
          : {}),
        messageId: transcriptMessageId,
      });
      continue;
    }

    if (isToolResultContentType(item.type)) {
      const name = resolveToolName(item, m);
      const cardId = resolveToolCardId(item, m, index, prefix);
      const callId = resolveToolCallId(item, m);
      const existing = findFirstUnmatchedCard(cards, cardId, name, fallbackMatchedCards);
      const text = extractToolText(item);
      const preview = extractToolPreview(text, name);
      const isError = readToolErrorFlag(item) ?? messageIsError;
      const details = item.details ?? m.details;
      if (existing) {
        fallbackMatchedCards.add(existing);
        existing.callId ??= callId;
        existing.completed = true;
        existing.outputText = text;
        existing.preview = preview;
        if (details !== undefined) {
          existing.details = details;
        }
        if (isError !== undefined) {
          existing.isError = isError;
        }
        continue;
      }
      cards.push({
        id: cardId,
        ...(callId ? { callId } : {}),
        name,
        completed: true,
        outputText: text,
        ...(details !== undefined ? { details } : {}),
        messageId: transcriptMessageId,
        ...(isError !== undefined ? { isError } : {}),
        preview,
      });
    }
  }

  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  const isStandaloneToolMessage =
    isToolResultMessage(message) ||
    role === "tool" ||
    role === "function" ||
    typeof m.toolName === "string" ||
    typeof m.tool_name === "string";

  if (isStandaloneToolMessage && cards.length === 0) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    const callId = resolveToolCallId({}, m);
    cards.push({
      id: resolveToolCardId({}, m, 0, prefix),
      ...(callId ? { callId } : {}),
      name,
      completed: isToolResultMessage(message) || role === "tool" || role === "function",
      outputText: text,
      ...(m.details !== undefined ? { details: m.details } : {}),
      messageId: transcriptMessageId,
      ...(messageIsError !== undefined ? { isError: messageIsError } : {}),
      preview: extractToolPreview(text, name),
    });
  }

  return cards;
}

const toolCardsByMessage = new WeakMap<object, Map<string, ToolCard[]>>();

export function extractToolCardsCached(message: unknown, prefix = "tool"): ToolCard[] {
  if (!message || typeof message !== "object") {
    return extractToolCards(message, prefix);
  }
  let byPrefix = toolCardsByMessage.get(message);
  if (!byPrefix) {
    byPrefix = new Map();
    toolCardsByMessage.set(message, byPrefix);
  }
  const cached = byPrefix.get(prefix);
  if (cached) {
    return cached;
  }
  const cards = extractToolCards(message, prefix);
  byPrefix.set(prefix, cards);
  return cards;
}
