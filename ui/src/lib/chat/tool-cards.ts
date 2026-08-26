import {
  asNullableObjectRecord as readRecord,
  asNullableRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI chat domain owns pure tool-card extraction rules.
import {
  extractCanvasFromDetails,
  extractCanvasFromText,
} from "../../../../src/chat/canvas-render.js";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import { redactToolPayloadText } from "../browser-redact.ts";
import type { ToolCard, ToolCardOutcome } from "./chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";

export type ToolPreview = NonNullable<ToolCard["preview"]>;

function resolveTranscriptMessageId(message: Record<string, unknown>): string | undefined {
  if (typeof message.messageId === "string" && message.messageId.trim()) {
    return message.messageId;
  }
  const openClawMeta = message["__openclaw"];
  const transcriptMeta = asNullableRecord(openClawMeta);
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

function parseJsonRecord(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    return readRecord(JSON.parse(trimmed));
  } catch {
    return null;
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

function readToolExitCode(...values: unknown[]): number | undefined {
  for (const value of values) {
    const record = readRecord(value);
    const exitCode = record?.exitCode ?? record?.exit_code;
    if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
      return exitCode;
    }
  }
  return undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

function isToolErrorOutput(outputText: string | undefined): boolean {
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
  if (!isRecord(parsed)) {
    return false;
  }
  const obj = parsed;
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
  const preview = extractCanvasFromText(outputText, toolName);
  return preview?.surface === "assistant_message"
    ? { ...preview, surface: "assistant_message" }
    : undefined;
}

function extractToolDetailsPreview(details: unknown): ToolCard["preview"] | undefined {
  const preview = extractCanvasFromDetails(details);
  return preview?.surface === "assistant_message"
    ? { ...preview, surface: "assistant_message" }
    : undefined;
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

function resolveParentToolCallId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  const value = item.parentToolCallId ?? message.parentToolCallId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveCodeModeControl(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
): ToolCard["codeModeControl"] | undefined {
  const candidates = [
    item.codeModeControl,
    message.codeModeControl,
    readRecord(item.details)?.openclawCodeModeControl,
    readRecord(message.details)?.openclawCodeModeControl,
  ];
  for (const candidate of candidates) {
    const value = readRecord(candidate);
    if (value?.kind !== "exec" && value?.kind !== "wait") {
      continue;
    }
    const language = value.language;
    return {
      kind: value.kind,
      ...(language === "javascript" || language === "typescript" ? { language } : {}),
    };
  }
  return undefined;
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

const TOOL_ARGUMENT_PREVIEW_KEYS = [
  "message",
  "prompt",
  "task",
  "query",
  "text",
  "description",
] as const;

/** First meaningful user-authored line for compact generic tool rows. */
export function resolveCollapsedToolArgumentPreview(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const record = args;
  for (const key of TOOL_ARGUMENT_PREVIEW_KEYS) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const firstLine = value.split(/\r\n?|\n/).find((line) => line.trim().length > 0);
    const preview = formatCollapsedToolPreviewText(
      firstLine ? redactToolPayloadText(firstLine) : undefined,
    );
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

function extractToolCards(message: unknown, prefix = "tool"): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const messageIsError = readToolErrorFlag(m);
  const isLiveToolStream = m["__openclawToolStreamLive"] === true;
  const liveDiff = readRecord(m["__openclawToolStreamDiffStat"]);
  const liveDiffStat =
    typeof liveDiff?.added === "number" &&
    Number.isInteger(liveDiff.added) &&
    liveDiff.added >= 0 &&
    typeof liveDiff.removed === "number" &&
    Number.isInteger(liveDiff.removed) &&
    liveDiff.removed >= 0
      ? { added: liveDiff.added, removed: liveDiff.removed }
      : undefined;
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
      const parentCallId = resolveParentToolCallId(item, m);
      const codeModeControl = resolveCodeModeControl(item, m);
      const details = item.details ?? m.details;
      cards.push({
        id: resolveToolCardId(item, m, index, prefix),
        ...(callId ? { callId } : {}),
        ...(parentCallId ? { parentCallId } : {}),
        ...(codeModeControl ? { codeModeControl } : {}),
        name: resolveToolName(item, m),
        args,
        inputText: serializeToolInput(args),
        ...(details !== undefined ? { details } : {}),
        ...(isLiveToolStream
          ? { live: true, completed: m["__openclawToolStreamResultReceived"] === true }
          : {}),
        ...(liveDiffStat ? { liveDiffStat } : {}),
        messageId: transcriptMessageId,
      });
      continue;
    }

    if (isToolResultContentType(item.type)) {
      const name = resolveToolName(item, m);
      const cardId = resolveToolCardId(item, m, index, prefix);
      const callId = resolveToolCallId(item, m);
      const parentCallId = resolveParentToolCallId(item, m);
      const codeModeControl = resolveCodeModeControl(item, m);
      const existing =
        cards.find((card) => card.id === cardId) ??
        cards.find(
          (card) =>
            // Same-name fallback belongs to legacy blocks missing an explicit identity.
            (!callId || !card.callId) &&
            card.name === name &&
            card.outputText === undefined &&
            !fallbackMatchedCards.has(card),
        );
      const text = extractToolText(item);
      const details = item.details ?? m.details;
      const preview = extractToolDetailsPreview(details) ?? extractToolPreview(text, name);
      const isError = readToolErrorFlag(item) ?? messageIsError;
      const exitCode = readToolExitCode(item, details, text ? parseJsonRecord(text) : undefined, m);
      if (existing) {
        fallbackMatchedCards.add(existing);
        existing.callId ??= callId;
        existing.parentCallId ??= parentCallId;
        existing.codeModeControl ??= codeModeControl;
        // Live tool-stream messages emit a toolresult block for partial
        // `update` output too; completion there is owned by the stream's
        // resultReceived marker (set at card creation), not block presence —
        // otherwise a running tool flips to "succeeded" mid-execution.
        if (!isLiveToolStream) {
          existing.completed = true;
        }
        existing.outputText = text;
        existing.preview = preview;
        if (details !== undefined) {
          existing.details = details;
        }
        if (isError !== undefined) {
          existing.isError = isError;
        }
        if (exitCode !== undefined) {
          existing.exitCode = exitCode;
        }
        continue;
      }
      cards.push({
        id: cardId,
        ...(callId ? { callId } : {}),
        ...(parentCallId ? { parentCallId } : {}),
        ...(codeModeControl ? { codeModeControl } : {}),
        name,
        completed: true,
        outputText: text,
        ...(details !== undefined ? { details } : {}),
        messageId: transcriptMessageId,
        ...(isError !== undefined ? { isError } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
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
    const parentCallId = resolveParentToolCallId({}, m);
    const codeModeControl = resolveCodeModeControl({}, m);
    const exitCode = readToolExitCode(m, m.details, text ? parseJsonRecord(text) : undefined);
    cards.push({
      id: resolveToolCardId({}, m, 0, prefix),
      ...(callId ? { callId } : {}),
      ...(parentCallId ? { parentCallId } : {}),
      ...(codeModeControl ? { codeModeControl } : {}),
      name,
      completed: isToolResultMessage(message) || role === "tool" || role === "function",
      outputText: text,
      ...(m.details !== undefined ? { details: m.details } : {}),
      messageId: transcriptMessageId,
      ...(messageIsError !== undefined ? { isError: messageIsError } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      preview: extractToolDetailsPreview(m.details) ?? extractToolPreview(text, name),
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
