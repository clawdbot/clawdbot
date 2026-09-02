// Generated inbound context is current-turn model input, never historical display text.
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { escapeRegExp } from "../../shared/regexp.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "./delivery-hints.js";
import { INBOUND_CONTEXT_MARKER } from "./inbound-context-marker.js";

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const CHANNEL_CONTEXT_HEADER = `Context: ${INBOUND_CONTEXT_MARKER}`;
const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";
const METADATA_TOKENS_RE = new RegExp(
  [INBOUND_CONTEXT_MARKER, ...MESSAGE_TOOL_DELIVERY_HINTS].map(escapeRegExp).join("|"),
  "g",
);

type TextLine = { start: number; end: number; next: number; trimmed: string };
type LineSpan = { start: number; next: number };

function readTextLine(text: string, start: number): TextLine | undefined {
  if (start > text.length) {
    return undefined;
  }
  const newline = text.indexOf("\n", start);
  const end = newline < 0 ? text.length : newline;
  return { start, end, next: end + 1, trimmed: text.slice(start, end).trim() };
}

function findTextLine(text: string, value: string, from = 0): TextLine | undefined {
  let index = text.indexOf(value, from);
  while (index >= 0) {
    const start = text.lastIndexOf("\n", index - 1) + 1;
    const line = readTextLine(text, start)!;
    if (line.trimmed === value) {
      return line;
    }
    index = text.indexOf(value, line.next);
  }
  return undefined;
}

function skipEmptyLines(text: string, start: number, trimmed = true): number {
  let next = start;
  let line = readTextLine(text, next);
  while (line && (trimmed ? line.trimmed === "" : line.start === line.end)) {
    next = line.next;
    line = readTextLine(text, next);
  }
  return next;
}

function isInboundContextHeaderLine(line: string): boolean {
  return line.length > INBOUND_CONTEXT_MARKER.length && line.endsWith(INBOUND_CONTEXT_MARKER);
}

function isMessageToolDeliveryHintLine(line: string): boolean {
  return MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => hint === line);
}

/** Fast check for whether text contains any inbound metadata sentinel. */
export function hasInboundMetadataSentinel(text: string): boolean {
  return (
    text.includes(INBOUND_CONTEXT_MARKER) ||
    MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => text.includes(hint)) ||
    // Bare Context: is a sentinel only as a complete line.
    (text.includes(ACTIVE_MEMORY_CONTEXT_HEADER) && /^[ \t]*Context:[ \t]*$/m.test(text))
  );
}

function metadataBlockEnd(text: string, header: TextLine): number {
  let line = readTextLine(text, header.next);
  if (line?.trimmed === "```json") {
    return findTextLine(text, "```", line.next)?.next ?? text.length + 1;
  }
  // Generated prose context ends at the next blank separator, including its blanks.
  while (line && line.trimmed !== "") {
    line = readTextLine(text, line.next);
  }
  return skipEmptyLines(text, line?.start ?? text.length + 1);
}

function removeLineSpans(text: string, spans: LineSpan[]): string {
  if (spans.length === 0) {
    return text;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    // A removed final line also owns the preceding separator, like split/filter/join.
    const start = span.next > text.length && span.start > 0 ? span.start - 1 : span.start;
    parts.push(text.slice(cursor, Math.max(cursor, start)));
    cursor = span.next;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function stripActiveMemoryPromptPrefixBlocks(text: string): string {
  if (!text.includes(ACTIVE_MEMORY_OPEN_TAG)) {
    return text;
  }
  const spans: LineSpan[] = [];
  let header = findTextLine(text, ACTIVE_MEMORY_CONTEXT_HEADER);
  while (header) {
    const open = readTextLine(text, header.next);
    const close =
      open?.trimmed === ACTIVE_MEMORY_OPEN_TAG
        ? findTextLine(text, ACTIVE_MEMORY_CLOSE_TAG, open.next)
        : undefined;
    const next = close ? skipEmptyLines(text, close.next) : header.next;
    if (close) {
      spans.push({ start: header.start, next });
    }
    header = findTextLine(text, ACTIVE_MEMORY_CONTEXT_HEADER, next);
  }
  return removeLineSpans(text, spans);
}

function stripTrailingContextBlockSuffix(text: string): string {
  const header = findTextLine(text, CHANNEL_CONTEXT_HEADER);
  if (!header) {
    return text;
  }
  let end = header.start;
  while (end > 0) {
    const previous = end === 1 ? 0 : text.lastIndexOf("\n", end - 2) + 1;
    if (text.slice(previous, end - 1).trim() !== "") {
      break;
    }
    end = previous;
  }
  return text.slice(0, Math.max(0, end - 1));
}

/** Strips all injected inbound metadata blocks from user-visible text. */
export function stripInboundMetadata(text: string): string {
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!hasInboundMetadataSentinel(withoutTimestamp)) {
    return withoutTimestamp;
  }
  // Active-memory removal precedes fence parsing, including blocks inside metadata JSON.
  const source = stripActiveMemoryPromptPrefixBlocks(withoutTimestamp);
  const spans: LineSpan[] = [];
  const tokens = new RegExp(METADATA_TOKENS_RE);
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source))) {
    const start = source.lastIndexOf("\n", match.index - 1) + 1;
    const line = readTextLine(source, start)!;
    tokens.lastIndex = line.next;
    if (line.trimmed === CHANNEL_CONTEXT_HEADER) {
      spans.push({ start, next: source.length + 1 });
      break;
    }
    if (isInboundContextHeaderLine(line.trimmed)) {
      tokens.lastIndex = metadataBlockEnd(source, line);
      spans.push({ start, next: tokens.lastIndex });
    } else if (isMessageToolDeliveryHintLine(line.trimmed)) {
      spans.push({ start, next: line.next });
    }
  }
  return removeLineSpans(source, spans)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}

/** Strips only leading inbound metadata blocks while preserving later user text. */
export function stripLeadingInboundMetadata(text: string): string {
  if (!hasInboundMetadataSentinel(text)) {
    return text;
  }
  const source = stripActiveMemoryPromptPrefixBlocks(text);
  let start = skipEmptyLines(source, 0, false);
  let line = readTextLine(source, start);
  const strippedDeliveryHint = Boolean(line && isMessageToolDeliveryHintLine(line.trimmed));
  while (line && isMessageToolDeliveryHintLine(line.trimmed)) {
    start = skipEmptyLines(source, line.next, false);
    line = readTextLine(source, start);
  }
  if (!line) {
    return "";
  }
  if (!isInboundContextHeaderLine(line.trimmed)) {
    return stripTrailingContextBlockSuffix(strippedDeliveryHint ? source.slice(start) : source);
  }
  while (line && isInboundContextHeaderLine(line.trimmed)) {
    start = skipEmptyLines(source, metadataBlockEnd(source, line));
    line = readTextLine(source, start);
  }
  return stripTrailingContextBlockSuffix(source.slice(start));
}

function parseInboundMetaBlock(text: string, label: string): Record<string, unknown> | null {
  const header = findTextLine(text, `${label} ${INBOUND_CONTEXT_MARKER}`);
  const open = header && readTextLine(text, header.next);
  if (open?.trimmed !== "```json") {
    return null;
  }
  const close = findTextLine(text, "```", open.next);
  return close ? (safeParseJsonRecord(text.slice(open.next, close.start).trim()) ?? null) : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      // Only selected label strings escape the parser; do not recursively clone metadata.
      return value.trim().replaceAll("`\u200b``", "```");
    }
  }
  return null;
}

/** Extracts the sender label from injected inbound metadata when present. */
export function extractInboundSenderLabel(text: string): string | null {
  if (!text.includes(INBOUND_CONTEXT_MARKER)) {
    return null;
  }
  const sender = parseInboundMetaBlock(text, "Sender:");
  const label = firstNonEmptyString(
    sender?.label,
    sender?.name,
    sender?.username,
    sender?.e164,
    sender?.id,
  );
  if (label) {
    return label;
  }
  const conversationSender = parseInboundMetaBlock(text, "Conversation info:")?.sender;
  return conversationSender &&
    typeof conversationSender === "object" &&
    !Array.isArray(conversationSender)
    ? firstNonEmptyString(
        (conversationSender as Record<string, unknown>).name,
        (conversationSender as Record<string, unknown>).username,
        (conversationSender as Record<string, unknown>).e164,
        (conversationSender as Record<string, unknown>).id,
      )
    : firstNonEmptyString(conversationSender);
}
