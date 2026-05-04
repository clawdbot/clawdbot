import { stripLeadingInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { formatRawAssistantErrorForUi } from "../shared/assistant-error-format.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { stripAnsi } from "../terminal/ansi.js";
import { formatTokenCount } from "../utils/usage-format.js";

const REPLACEMENT_CHAR_RE = /\uFFFD/g;
const MAX_TOKEN_CHARS = 32;
const LONG_TOKEN_RE = /\S{33,}/g;
const LONG_TOKEN_TEST_RE = /\S{33,}/;
const BINARY_LINE_REPLACEMENT_THRESHOLD = 12;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
const EDGE_PUNCTUATION_RE = /^[`"'([{<]+|[`"')\]}>.,:;!?]+$/g;
const ALPHANUMERIC_RE = /[A-Za-z0-9]/;
const TOKENISH_MIN_LENGTH = 24;
const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const RTL_ISOLATE_START = "\u2067";
const RTL_ISOLATE_END = "\u2069";
// Fenced code blocks (``` or ~~~). Lazy on content; tolerates info string after
// the opening fence. Closing fence must sit on its own line.
const FENCED_CODE_RE = /(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*/g;
// Inline code spans with balanced backtick run (`code`, ``co`de``, ...).
const INLINE_CODE_RE = /(`+)(?:(?!\1).)+?\1/g;

function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1Control = code >= 0x7f && code <= 0x9f;
    if (isAsciiControl || isC1Control) {
      return true;
    }
  }
  return false;
}

function stripControlChars(text: string): string {
  if (!hasControlChars(text)) {
    return text;
  }
  let sanitized = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1Control = code >= 0x7f && code <= 0x9f;
    if (!isAsciiControl && !isC1Control) {
      sanitized += char;
    }
  }
  return sanitized;
}

function chunkToken(token: string, maxChars: number): string[] {
  if (token.length <= maxChars) {
    return [token];
  }
  const chunks: string[] = [];
  for (let i = 0; i < token.length; i += maxChars) {
    chunks.push(token.slice(i, i + maxChars));
  }
  return chunks;
}

function isCopySensitiveToken(token: string): boolean {
  const coreToken = token.replace(EDGE_PUNCTUATION_RE, "");
  const candidate = coreToken || token;

  if (URL_PREFIX_RE.test(candidate)) {
    return true;
  }
  if (
    candidate.startsWith("/") ||
    candidate.startsWith("~/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../")
  ) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(candidate) || candidate.startsWith("\\\\")) {
    return true;
  }
  if (candidate.includes("/") || candidate.includes("\\")) {
    return true;
  }
  // Identifiers that look file-like, dotted, or hyphen/underscore-separated:
  // package names, entity IDs, kebab/snake CLI flags, dotted module paths.
  if (
    FILE_LIKE_RE.test(candidate) &&
    (candidate.includes("_") || candidate.includes("-") || candidate.includes("."))
  ) {
    return true;
  }

  // Preserve long credential-like tokens (hex/base62/etc.) to avoid introducing
  // visible spaces that users may copy back into secrets.
  if (candidate.length >= TOKENISH_MIN_LENGTH && /[a-z]/i.test(candidate) && /\d/.test(candidate)) {
    return true;
  }
  return false;
}

function normalizeLongTokenForDisplay(token: string): string {
  // Preserve copy-sensitive tokens exactly (paths/urls/file-like names).
  if (isCopySensitiveToken(token)) {
    return token;
  }
  // Pure symbol/punctuation runs (table borders made of `─`, `=`, `-`) carry
  // no copyable identifier; chunking would corrupt the visible structure.
  if (!ALPHANUMERIC_RE.test(token)) {
    return token;
  }
  return chunkToken(token, MAX_TOKEN_CHARS).join(" ");
}

type Segment = { kind: "prose" | "code"; text: string };

function partitionByRegex(text: string, re: RegExp): Segment[] {
  const parts: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({ kind: "prose", text: text.slice(lastIndex, start) });
    }
    parts.push({ kind: "code", text: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: "prose", text: text.slice(lastIndex) });
  }
  return parts;
}

// Apply `transform` only to spans of `text` that are not inside fenced code
// blocks or inline code spans. Code regions pass through verbatim so long
// identifiers, dotted IDs, package names, and shell line-continuations the
// user may copy stay byte-for-byte intact.
function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  const fenced = partitionByRegex(text, FENCED_CODE_RE);
  return fenced
    .map((seg) => {
      if (seg.kind === "code") {
        return seg.text;
      }
      const inline = partitionByRegex(seg.text, INLINE_CODE_RE);
      return inline.map((s) => (s.kind === "code" ? s.text : transform(s.text))).join("");
    })
    .join("");
}

function redactBinaryLikeLine(line: string): string {
  const replacementCount = (line.match(REPLACEMENT_CHAR_RE) || []).length;
  if (
    replacementCount >= BINARY_LINE_REPLACEMENT_THRESHOLD &&
    replacementCount * 2 >= line.length
  ) {
    return "[binary data omitted]";
  }
  return line;
}

function isolateRtlLine(line: string): string {
  if (!RTL_SCRIPT_RE.test(line) || BIDI_CONTROL_RE.test(line)) {
    return line;
  }
  return `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}`;
}

function applyRtlIsolation(text: string): string {
  if (!RTL_SCRIPT_RE.test(text)) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => isolateRtlLine(line))
    .join("\n");
}

export function sanitizeRenderableText(text: string): string {
  if (!text) {
    return text;
  }

  const hasAnsi = text.includes("\u001b");
  const hasReplacementChars = text.includes("\uFFFD");
  const hasLongTokens = LONG_TOKEN_TEST_RE.test(text);
  const hasControls = hasControlChars(text);
  if (!hasAnsi && !hasReplacementChars && !hasLongTokens && !hasControls) {
    return applyRtlIsolation(text);
  }

  const withoutAnsi = hasAnsi ? stripAnsi(text) : text;
  const withoutControlChars = hasControls ? stripControlChars(withoutAnsi) : withoutAnsi;
  const redacted = hasReplacementChars
    ? withoutControlChars
        .split("\n")
        .map((line) => redactBinaryLikeLine(line))
        .join("\n")
    : withoutControlChars;
  const tokenSafe = LONG_TOKEN_TEST_RE.test(redacted)
    ? transformOutsideCode(redacted, (segment) =>
        LONG_TOKEN_TEST_RE.test(segment)
          ? segment.replace(LONG_TOKEN_RE, normalizeLongTokenForDisplay)
          : segment,
      )
    : redacted;
  return applyRtlIsolation(tokenSafe);
}

export function resolveFinalAssistantText(params: {
  finalText?: string | null;
  streamedText?: string | null;
  errorMessage?: string | null;
}) {
  const finalText = params.finalText ?? "";
  if (finalText.trim()) {
    return finalText;
  }
  const streamedText = params.streamedText ?? "";
  if (streamedText.trim()) {
    return streamedText;
  }
  const errorMessage = params.errorMessage ?? "";
  if (errorMessage.trim()) {
    return formatRawAssistantErrorForUi(errorMessage);
  }
  return "(no output)";
}

export function composeThinkingAndContent(params: {
  thinkingText?: string;
  contentText?: string;
  showThinking?: boolean;
}) {
  const thinkingText = params.thinkingText?.trim() ?? "";
  const contentText = params.contentText?.trim() ?? "";
  const parts: string[] = [];

  if (params.showThinking && thinkingText) {
    parts.push(`[thinking]\n${thinkingText}`);
  }
  if (contentText) {
    parts.push(contentText);
  }

  return parts.join("\n\n").trim();
}

function asMessageRecord(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return message as Record<string, unknown>;
}

function resolveMessageRecord(
  message: unknown,
): { record: Record<string, unknown>; content: unknown } | undefined {
  const record = asMessageRecord(message);
  if (!record) {
    return undefined;
  }
  return { record, content: record.content };
}

function formatAssistantErrorFromRecord(record: Record<string, unknown>): string {
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stopReason !== "error") {
    return "";
  }
  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
  return formatRawAssistantErrorForUi(errorMessage);
}

function collectSanitizedBlockStrings(params: {
  content: unknown;
  blockType: "text" | "thinking";
  valueKey: "text" | "thinking";
}): string[] {
  if (!Array.isArray(params.content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of params.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === params.blockType && typeof rec[params.valueKey] === "string") {
      parts.push(sanitizeRenderableText(rec[params.valueKey] as string));
    }
  }
  return parts;
}

/**
 * Extract ONLY thinking blocks from message content.
 * Model-agnostic: returns empty string if no thinking blocks exist.
 */
export function extractThinkingFromMessage(message: unknown): string {
  const resolved = resolveMessageRecord(message);
  if (!resolved) {
    return "";
  }
  const { content } = resolved;
  if (typeof content === "string") {
    return "";
  }
  const parts = collectSanitizedBlockStrings({
    content,
    blockType: "thinking",
    valueKey: "thinking",
  });
  return parts.join("\n").trim();
}

/**
 * Extract ONLY text content blocks from message (excludes thinking).
 * Model-agnostic: works for any model with text content blocks.
 */
export function extractContentFromMessage(message: unknown): string {
  const resolved = resolveMessageRecord(message);
  if (!resolved) {
    return "";
  }
  const { record, content } = resolved;

  if (record.role === "assistant") {
    if (typeof content === "string") {
      return sanitizeRenderableText(content).trim();
    }
    if (Array.isArray(content)) {
      return extractAssistantRenderableContent(record);
    }
  }

  if (typeof content === "string") {
    return sanitizeRenderableText(content).trim();
  }

  const parts = collectSanitizedBlockStrings({
    content,
    blockType: "text",
    valueKey: "text",
  });
  if (parts.length > 0) {
    return parts.join("\n").trim();
  }
  return formatAssistantErrorFromRecord(record);
}

function extractAssistantRenderableContent(record: Record<string, unknown>): string {
  const visible = sanitizeRenderableText(extractAssistantVisibleText(record) ?? "").trim();
  if (visible) {
    return visible;
  }
  return formatAssistantErrorFromRecord(record);
}

function extractTextBlocks(content: unknown, opts?: { includeThinking?: boolean }): string {
  if (typeof content === "string") {
    return sanitizeRenderableText(content).trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = collectSanitizedBlockStrings({
    content,
    blockType: "text",
    valueKey: "text",
  });
  const thinkingParts =
    opts?.includeThinking === true
      ? collectSanitizedBlockStrings({
          content,
          blockType: "thinking",
          valueKey: "thinking",
        })
      : [];

  return composeThinkingAndContent({
    thinkingText: thinkingParts.join("\n").trim(),
    contentText: textParts.join("\n").trim(),
    showThinking: opts?.includeThinking ?? false,
  });
}

export function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean },
): string {
  const record = asMessageRecord(message);
  if (!record) {
    return "";
  }
  if (record.role === "assistant") {
    return composeThinkingAndContent({
      thinkingText: extractThinkingFromMessage(record),
      contentText: extractAssistantRenderableContent(record),
      showThinking: opts?.includeThinking ?? false,
    });
  }
  const text = extractTextBlocks(record.content, opts);
  if (text) {
    if (record.role === "user" || record.command === true) {
      return stripLeadingInboundMetadata(text);
    }
    return text;
  }

  const errorText = formatAssistantErrorFromRecord(record);
  if (!errorText) {
    return "";
  }
  return errorText;
}

export function isCommandMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return (message as Record<string, unknown>).command === true;
}

export function formatTokens(total?: number | null, context?: number | null) {
  if (total == null && context == null) {
    return "tokens ?";
  }
  const totalLabel = total == null ? "?" : formatTokenCount(total);
  if (context == null) {
    return `tokens ${totalLabel}`;
  }
  const pct =
    typeof total === "number" && context > 0
      ? Math.min(999, Math.round((total / context) * 100))
      : null;
  return `tokens ${totalLabel}/${formatTokenCount(context)}${pct !== null ? ` (${pct}%)` : ""}`;
}

export function formatContextUsageLine(params: {
  total?: number | null;
  context?: number | null;
  remaining?: number | null;
  percent?: number | null;
}) {
  const totalLabel = typeof params.total === "number" ? formatTokenCount(params.total) : "?";
  const ctxLabel = typeof params.context === "number" ? formatTokenCount(params.context) : "?";
  const pct = typeof params.percent === "number" ? Math.min(999, Math.round(params.percent)) : null;
  const remainingLabel =
    typeof params.remaining === "number" ? `${formatTokenCount(params.remaining)} left` : null;
  const pctLabel = pct !== null ? `${pct}%` : null;
  const extra = [remainingLabel, pctLabel].filter(Boolean).join(", ");
  return `tokens ${totalLabel}/${ctxLabel}${extra ? ` (${extra})` : ""}`;
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
