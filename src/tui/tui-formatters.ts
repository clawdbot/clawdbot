import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Formats terminal-safe strings for TUI messages and status surfaces.
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { stripLeadingInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import type { SessionGoal } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { formatRawAssistantErrorForUi } from "../shared/assistant-error-format.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import { chunkTextByBreakResolver } from "../shared/text-chunking.js";
import { formatTokenCount } from "../utils/usage-format.js";
import type { SessionInfo } from "./tui-types.js";

const REPLACEMENT_CHAR_RE = /\uFFFD/g;
const MAX_TOKEN_CHARS = 32;
const LONG_TOKEN_RE = /\S{33,}/g;
const LONG_TOKEN_TEST_RE = /\S{33,}/;
const BINARY_LINE_REPLACEMENT_THRESHOLD = 12;
const MAX_TUI_ABORT_DIAGNOSTIC_LENGTH = 160;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
const EDGE_PUNCTUATION_RE = /^[`"'([{<]+|[`"')\]}>.,:;!?]+$/g;
const ALPHANUMERIC_RE = /[A-Za-z0-9]/;
const TOKENISH_MIN_LENGTH = 24;
const RTL_SCRIPT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const BIDI_CONTROL_GLOBAL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RTL_ISOLATE_START = "\u2067";
const RTL_ISOLATE_END = "\u2069";
// Fenced code blocks (``` or ~~~). Lazy on content; tolerates info string after
// the opening fence. Closing fence must sit on its own line.
const FENCED_CODE_RE = /(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*/g;
// Inline code spans with balanced backtick run (`code`, ``co`de``, ...).
const INLINE_CODE_RE = /(`+)(?:(?!\1).)+?\1/g;

/** Keep routing/provider/profile details in session state, not the compact footer. */
function formatModelFooter(params: {
  model?: string | null;
  thinkingLevel?: string | null;
}): string {
  const model = splitTrailingAuthProfile(params.model ?? "").model || "unknown";
  const thinkingLevel = params.thinkingLevel?.trim();
  return thinkingLevel && thinkingLevel !== "off" ? `${model} ${thinkingLevel}` : model;
}

/** Format the compact TUI footer from authoritative session and process state. */
export function formatTuiFooter(params: {
  agentLabel: string;
  sessionLabel: string;
  sessionInfo: SessionInfo;
  thinkingLevel?: string | null;
  deliver: boolean;
}): string {
  const { sessionInfo } = params;
  const fastLabel =
    sessionInfo.fastMode === "auto" ? "fast:auto" : sessionInfo.fastMode === true ? "fast" : null;
  const verbose = sessionInfo.verboseLevel ?? "off";
  const trace = sessionInfo.traceLevel ?? "off";
  const reasoning = sessionInfo.reasoningLevel ?? "off";
  const traceLabel = trace === "raw" ? "trace:raw" : trace === "on" ? "trace" : null;
  const reasoningLabel =
    reasoning === "on" ? "reasoning" : reasoning === "stream" ? "reasoning:stream" : null;
  const footer = [
    `agent ${params.agentLabel}`,
    `session ${params.sessionLabel}`,
    formatModelFooter({ model: sessionInfo.model, thinkingLevel: params.thinkingLevel }),
    formatGoalFooter(sessionInfo.goal),
    fastLabel,
    verbose !== "off" ? `verbose ${verbose}` : null,
    traceLabel,
    reasoningLabel,
    `deliver:${params.deliver ? "on" : "off"}`,
    formatTokens(sessionInfo.totalTokens ?? null, sessionInfo.contextTokens ?? null),
  ]
    .filter(Boolean)
    .join(" | ");
  return sanitizeRenderableLine(footer);
}

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

function sanitizeTerminalControlsAndBinary(text: string): string {
  const hasAnsi = text.includes("\u001b") || text.includes("\u009b") || text.includes("\u009d");
  const withoutAnsi = hasAnsi ? stripAnsi(text) : text;
  const withoutControlChars = hasControlChars(withoutAnsi)
    ? stripControlChars(withoutAnsi)
    : withoutAnsi;
  const withoutBidiControls = BIDI_CONTROL_RE.test(withoutControlChars)
    ? withoutControlChars.replace(BIDI_CONTROL_GLOBAL_RE, "")
    : withoutControlChars;
  return withoutBidiControls.includes("\uFFFD")
    ? withoutBidiControls
        .split("\n")
        .map((line) => redactBinaryLikeLine(line))
        .join("\n")
    : withoutBidiControls;
}

export function isTerminalSafeAutocompleteValue(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || BIDI_CONTROL_RE.test(char)) {
      return false;
    }
  }
  return true;
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
  // CJK text naturally appears without spaces between words. Inserting spaces
  // into long CJK runs makes assistant prose render with visible artifacts such
  // as "苦难 者". Let the TUI renderer wrap these runs at grapheme boundaries.
  if (CJK_SCRIPT_RE.test(token)) {
    return token;
  }
  // Pure symbol/punctuation runs (table borders made of `─`, `=`, `-`) carry
  // no copyable identifier; chunking would corrupt the visible structure.
  if (!ALPHANUMERIC_RE.test(token)) {
    return token;
  }
  return chunkTextByBreakResolver(token, MAX_TOKEN_CHARS, () => MAX_TOKEN_CHARS).join(" ");
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
  if (!RTL_SCRIPT_RE.test(line)) {
    return line;
  }
  return `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}`;
}

export function isolateRtlRenderedLine(line: string): string {
  if (!RTL_SCRIPT_RE.test(stripAnsi(line))) {
    return line;
  }
  const padding = line.match(/^(\s*)(.*\S)(\s*)$/u);
  if (!padding) {
    return line;
  }
  return `${padding[1]}${RTL_ISOLATE_START}${padding[2]}${RTL_ISOLATE_END}${padding[3]}`;
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

export function sanitizeMarkdownSource(text: string): string {
  if (!text) {
    return text;
  }

  const hasLongTokens = LONG_TOKEN_TEST_RE.test(text);
  const controlSafe = sanitizeTerminalControlsAndBinary(text);
  if (controlSafe === text && !hasLongTokens) {
    return text;
  }

  return LONG_TOKEN_TEST_RE.test(controlSafe)
    ? transformOutsideCode(controlSafe, (segment) =>
        LONG_TOKEN_TEST_RE.test(segment)
          ? segment.replace(LONG_TOKEN_RE, normalizeLongTokenForDisplay)
          : segment,
      )
    : controlSafe;
}

export function sanitizeRenderableText(text: string): string {
  return applyRtlIsolation(sanitizeMarkdownSource(text));
}

export function sanitizeRenderableLine(text: string): string {
  const line = sanitizeTerminalControlsAndBinary(text).replace(/\s+/gu, " ").trim();
  return applyRtlIsolation(line);
}

/** Render error causes without exposing secrets or terminal control sequences. */
export function formatTuiErrorMessage(error: unknown): string {
  return sanitizeRenderableText(formatErrorMessage(error));
}

export function formatTuiAbortDiagnostic(value: string | undefined): string | undefined {
  const diagnostic = sanitizeRenderableText(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return diagnostic
    ? diagnostic.length > MAX_TUI_ABORT_DIAGNOSTIC_LENGTH
      ? `${truncateUtf16Safe(diagnostic, MAX_TUI_ABORT_DIAGNOSTIC_LENGTH - 1)}…`
      : diagnostic
    : undefined;
}

export function resolveFinalAssistantText(params: {
  finalText?: string | null;
  streamedText?: string | null;
  errorMessage?: string | null;
  attachmentText?: string | null;
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
  const attachmentText = params.attachmentText ?? "";
  if (attachmentText.trim()) {
    return attachmentText;
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

type TuiAttachmentKind = "image" | "audio" | "video" | "file" | "media";

const TUI_ATTACHMENT_BLOCK_KINDS: Readonly<Record<string, TuiAttachmentKind>> = {
  image: "image",
  input_image: "image",
  image_url: "image",
  audio: "audio",
  video: "video",
  file: "file",
  document: "file",
};

function resolveTuiAttachmentBlockKind(block: Record<string, unknown>): TuiAttachmentKind | null {
  const type = typeof block.type === "string" ? block.type : "";
  const directKind = TUI_ATTACHMENT_BLOCK_KINDS[type];
  if (directKind) {
    return directKind;
  }
  if (type !== "attachment") {
    return null;
  }
  const attachment = asMessageRecord(block.attachment);
  const declaredKind = attachment?.kind;
  if (declaredKind === "image" || declaredKind === "sticker") {
    return "image";
  }
  if (declaredKind === "audio" || declaredKind === "video") {
    return declaredKind;
  }
  const mimeKind =
    typeof attachment?.mimeType === "string" ? attachment.mimeType.split("/", 1)[0] : "";
  return mimeKind === "image" || mimeKind === "audio" || mimeKind === "video" ? mimeKind : "file";
}

/** Keep optimistic session projection aligned with the terminal's attachment renderer. */
export function isTuiAssistantAttachmentBlock(block: unknown): boolean {
  const entry = asMessageRecord(block);
  return entry ? resolveTuiAttachmentBlockKind(entry) !== null : false;
}

function resolvePersistedTuiAttachmentKind(
  fact: NonNullable<ReturnType<typeof readPersistedMediaFacts>>[number],
): TuiAttachmentKind {
  if (isImageMediaFact(fact)) {
    return "image";
  }
  if (fact.kind === "audio" || fact.kind === "video") {
    return fact.kind;
  }
  return "file";
}

/** Render assistant attachments without exposing their sources or capability URLs. */
export function extractAssistantAttachmentText(message: unknown): string {
  const record = asMessageRecord(message);
  if (!record) {
    return "";
  }
  const contentAttachments = Array.isArray(record.content)
    ? record.content.flatMap((block) => {
        const entry = asMessageRecord(block);
        const kind = entry ? resolveTuiAttachmentBlockKind(entry) : null;
        return kind ? [`Attached ${kind}`] : [];
      })
    : [];
  if (contentAttachments.length > 0) {
    return contentAttachments.join("\n");
  }

  const persistedAttachments = (readPersistedMediaFacts(record) ?? [])
    .filter((fact) => fact.path || fact.url || fact.contentType || fact.kind)
    .map((fact) => `Attached ${resolvePersistedTuiAttachmentKind(fact)}`);
  if (persistedAttachments.length > 0) {
    return persistedAttachments.join("\n");
  }

  const legacyMedia = [
    ...(typeof record.mediaUrl === "string" && record.mediaUrl.trim() ? [record.mediaUrl] : []),
    ...(Array.isArray(record.mediaUrls)
      ? record.mediaUrls.filter((value) => typeof value === "string" && value.trim())
      : []),
  ];
  return legacyMedia.map(() => "Attached media").join("\n");
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
  const visible = sanitizeRenderableText(extractAssistantPhaseText(record) ?? "").trim();
  const pairingQr = extractPairingQrTerminalText(record);
  const content = [visible, pairingQr].filter(Boolean).join("\n\n").trim();
  if (content) {
    return content;
  }
  return formatAssistantErrorFromRecord(record);
}

function extractPairingQrTerminalText(record: Record<string, unknown>): string {
  const content = record.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const blockRecord = block as Record<string, unknown>;
    if (
      blockRecord.type === "openclaw_pairing_qr" &&
      typeof blockRecord.terminalText === "string"
    ) {
      const text = sanitizeRenderableText(blockRecord.terminalText).trim();
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n").trim();
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

function extractUserAttachmentText(record: Record<string, unknown>): string {
  const attachments: string[] = [];
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      const entry = asMessageRecord(block);
      if (entry?.type === "image") {
        attachments.push("Attached image");
      } else if (entry?.type === "attachment") {
        const attachment = asMessageRecord(entry.attachment);
        const label =
          typeof attachment?.label === "string"
            ? sanitizeRenderableText(attachment.label).trim()
            : "";
        attachments.push(
          label && label !== "Attached file" ? `Attached file: ${label}` : "Attached file",
        );
      }
    }
  }
  if (attachments.length > 0) {
    return attachments.join("\n");
  }

  // Gateway-persisted attachment-only turns keep blank content and carry
  // their authoritative attachments in __openclaw.media instead.
  return (readPersistedMediaFacts(record) ?? [])
    .filter((fact) => fact.path || fact.url || fact.contentType || fact.kind)
    .map((fact) => (isImageMediaFact(fact) ? "Attached image" : "Attached file"))
    .join("\n");
}

export function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean; includeAttachments?: boolean },
): string {
  const record = asMessageRecord(message);
  if (!record) {
    return "";
  }
  if (record.role === "assistant") {
    const contentText = extractAssistantRenderableContent(record);
    return composeThinkingAndContent({
      thinkingText: extractThinkingFromMessage(record),
      contentText:
        contentText ||
        (opts?.includeAttachments !== false ? extractAssistantAttachmentText(record) : ""),
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

  if (record.role === "user") {
    return extractUserAttachmentText(record);
  }

  const errorText = formatAssistantErrorFromRecord(record);
  if (!errorText) {
    return "";
  }
  return errorText;
}

/** Extract abort-visible text while keeping attachment-only aborts diagnostic-only. */
export function extractTuiAbortedText(message: unknown, includeThinking: boolean): string {
  return extractTextFromMessage(message, { includeThinking, includeAttachments: false });
}

export function isCommandMarkedMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return (message as Record<string, unknown>).command === true;
}

function formatTokens(total?: number | null, context?: number | null) {
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

function formatGoalUsage(goal: SessionGoal): string | null {
  if (goal.tokenBudget === undefined) {
    return goal.tokensUsed > 0 ? formatTokenCount(goal.tokensUsed) : null;
  }
  return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
}

function formatGoalFooter(goal?: SessionGoal): string | null {
  if (!goal) {
    return null;
  }
  const usage = formatGoalUsage(goal);
  const suffix = usage ? ` (${usage})` : "";
  switch (goal.status) {
    case "active":
      return `Pursuing goal${suffix}`;
    case "paused":
      return "Goal paused (/goal resume)";
    case "blocked":
      return "Goal blocked (/goal resume)";
    case "usage_limited":
      return "Goal hit usage limits (/goal resume)";
    case "budget_limited":
      return `Goal unmet${suffix}`;
    case "complete":
      return `Goal achieved${suffix}`;
  }
  return null;
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

export function formatPrimitiveString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
