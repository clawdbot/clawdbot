import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
// Telegram helper module supports format behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FILE_REF_EXTENSIONS_WITH_TLD,
  isAutoLinkedFileRef,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
  renderMarkdownIRChunksWithinLimit,
  tokenizeHtmlTags,
} from "openclaw/plugin-sdk/text-chunking";
import {
  protectTelegramAssistantTranscriptRoleHeaders,
  TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX,
} from "./format-assistant-transcript.js";
import { decodeTelegramHtmlEntities, findTelegramHtmlEntityEnd } from "./format-html.js";
import { renderTelegramMarkdownIR } from "./format-render.js";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(text: string): string {
  return escapeTelegramHtml(text);
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function isTelegramRichLinkHref(href: string): boolean {
  return /^(?:https?:\/\/|tg:\/\/|mailto:|tel:|#)/i.test(href);
}

/**
 * File extensions that share TLDs and commonly appear in code/documentation.
 * These are wrapped in <code> tags to prevent Telegram from generating
 * spurious domain registrar previews.
 *
 * Only includes extensions that are:
 * 1. Commonly used as file extensions in code/docs
 * 2. Rarely used as intentional domain references
 *
 * Excluded: .ai, .io, .tv, .fm (popular domain TLDs like x.ai, vercel.io, github.io)
 */
function buildTelegramLink(
  link: MarkdownLinkSpan,
  text: string,
  context: { origin: "authored" | "linkify" },
) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  if (link.start === link.end) {
    return null;
  }
  // Telegram rich links reject local or relative hrefs; keep the label visible
  // instead of letting one unsupported link drop the whole message.
  if (!isTelegramRichLinkHref(href)) {
    return null;
  }
  // Suppress auto-linkified file references (e.g. README.md → http://README.md)
  const label = text.slice(link.start, link.end);
  if (context.origin === "linkify" && isAutoLinkedFileRef(href, label)) {
    return null;
  }
  const safeHref = escapeHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: "</a>",
  };
}

function buildTelegramCodeBlockOpen(span: { language?: string }): string {
  if (!span.language) {
    return "<pre><code>";
  }
  return `<pre><code class="language-${escapeHtmlAttr(span.language)}">`;
}

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderTelegramMarkdownIR(ir, {
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
    buildCodeBlockOpen: buildTelegramCodeBlockOpen,
  });
}

function leadingWhitespaceLength(line: string): number {
  let length = 0;
  while (line[length] === " " || line[length] === "\t") {
    length++;
  }
  return length;
}

function isTelegramBulletLine(line: string): boolean {
  return /^[ \t]*(?:[•*+-])[ \t]+\S/.test(line);
}

function isTelegramListBoundaryLine(line: string): boolean {
  return /^[ \t]*(?:\d+\.|#{1,6})[ \t]+\S/.test(line);
}

function isMarkdownIndentedCodeLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(line);
}

function shouldPreserveTelegramListBoundarySpacing(previous: string, next: string): boolean {
  return (
    !isMarkdownIndentedCodeLine(previous) &&
    !isMarkdownIndentedCodeLine(next) &&
    isTelegramBulletLine(previous) &&
    isTelegramListBoundaryLine(next) &&
    leadingWhitespaceLength(next) <= leadingWhitespaceLength(previous)
  );
}

function preserveTelegramListBoundarySpacing(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  let previousLine = "";

  for (const line of lines) {
    const normalizedLine = line.replace(/\r$/, "");
    const isFenceLine = /^[ \t]*(?:```|~~~)/.test(normalizedLine);
    if (!inFence && shouldPreserveTelegramListBoundarySpacing(previousLine, normalizedLine)) {
      out.push("");
    }
    out.push(line);
    if (isFenceLine) {
      inFence = !inFence;
    }
    previousLine = normalizedLine;
  }

  return out.join("\n");
}

export function markdownToTelegramHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; wrapFileRefs?: boolean } = {},
): string {
  const tableMode = options.tableMode === "block" ? "code" : options.tableMode;
  const ir = markdownToIR(preserveTelegramListBoundarySpacing(markdown ?? ""), {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode,
  });
  const html = renderTelegramHtml(ir);
  const telegramHtml = renderSupportedTelegramHtml(html);
  // Apply file reference wrapping if requested (for chunked rendering)
  if (options.wrapFileRefs !== false) {
    return wrapFileReferencesInHtml(telegramHtml);
  }
  return telegramHtml;
}

/**
 * Wraps standalone file references (with TLD extensions) in <code> tags.
 * This prevents Telegram from treating them as URLs and generating
 * irrelevant domain registrar previews.
 *
 * Runs AFTER markdown→HTML conversion to avoid modifying HTML attributes.
 * Skips content inside <code>, <pre>, and <a> tags to avoid nesting issues.
 */
/** Escape regex metacharacters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HTML_MODE_TAG_PATTERN = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>$/;
const ESCAPED_HTML_TAG_PATTERN = /&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)(.*?)&gt;/g;
const TELEGRAM_HTML_ANCHOR_PATTERN =
  /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const TELEGRAM_HTML_BREAK_PATTERN = /<br\s*\/?>/gi;
const TELEGRAM_HTML_TAG_PATTERN = /<[^>]*>/g;
const TELEGRAM_RICH_HTML_TABLE_PATTERN = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
const TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const TELEGRAM_HTML_CAPTION_PATTERN = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i;
const TELEGRAM_HTML_COLSPAN_PATTERN = /\bcolspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i;
const TELEGRAM_SIMPLE_HTML_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "tg-spoiler",
]);
const TELEGRAM_ATTR_HTML_TAG_PATTERNS = new Map([
  ["a", /^\s+href="[^"]+"\s*$/],
  ["span", /^\s+class="tg-spoiler"\s*$/],
  ["tg-emoji", /^\s+emoji-id="[^"]+"\s*$/],
  ["tg-time", /^\s+unix="[1-9]\d*"(?:\s+format="(?:r|w?[dD]?[tT]?)")?\s*$/],
  ["blockquote", /^(\s+expandable)?\s*$/],
]);
const TELEGRAM_CODE_LANGUAGE_ATTR_PATTERN = /^\s+class="language-[^"]+"\s*$/;

type TelegramHtmlTagSupport = {
  simpleTags: ReadonlySet<string>;
  attrPatterns: ReadonlyMap<string, RegExp>;
};

const TELEGRAM_LEGACY_HTML_TAG_SUPPORT: TelegramHtmlTagSupport = {
  simpleTags: TELEGRAM_SIMPLE_HTML_TAGS,
  attrPatterns: TELEGRAM_ATTR_HTML_TAG_PATTERNS,
};

let fileReferencePattern: RegExp | undefined;
let orphanedTldPattern: RegExp | undefined;

function popLastTagName(tags: string[], name: string): boolean {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    if (tags[index] === name) {
      tags.splice(index, 1);
      return true;
    }
  }
  return false;
}

function isSupportedTelegramHtmlTag(rawTag: string, support: TelegramHtmlTagSupport): boolean {
  const match = HTML_MODE_TAG_PATTERN.exec(rawTag);
  if (!match) {
    return false;
  }
  const closing = match[1] === "/";
  const name = normalizeLowercaseStringOrEmpty(match[2]);
  const attrs = match[3] ?? "";
  if (closing) {
    return attrs.trim() === "" && (support.simpleTags.has(name) || support.attrPatterns.has(name));
  }
  if (name === "code" && TELEGRAM_CODE_LANGUAGE_ATTR_PATTERN.test(attrs)) {
    return true;
  }
  if (support.attrPatterns.get(name)?.test(attrs)) {
    return true;
  }
  return support.simpleTags.has(name) && attrs.trim() === "";
}

function hasOpenTelegramHtmlTag(tags: readonly string[], name: string): boolean {
  return tags.includes(name);
}

function preserveTelegramHtmlTag(
  rawTag: string,
  openTags: string[],
  escapeTag: (rawTag: string) => string,
  support: TelegramHtmlTagSupport = TELEGRAM_LEGACY_HTML_TAG_SUPPORT,
): string {
  const match = HTML_MODE_TAG_PATTERN.exec(rawTag);
  if (!match) {
    return escapeTag(rawTag);
  }
  const closing = match[1] === "/";
  const tagName = normalizeLowercaseStringOrEmpty(match[2]);
  const attrs = match[3] ?? "";
  if (!closing && tagName === "code" && TELEGRAM_CODE_LANGUAGE_ATTR_PATTERN.test(attrs)) {
    openTags.push(tagName);
    if (hasOpenTelegramHtmlTag(openTags, "pre")) {
      return rawTag;
    }
    return "<code>";
  }
  if (!isSupportedTelegramHtmlTag(rawTag, support)) {
    return escapeTag(rawTag);
  }
  if (closing) {
    return popLastTagName(openTags, tagName) ? rawTag : escapeTag(rawTag);
  }
  if (rawTag.trimEnd().endsWith("/>")) {
    return rawTag;
  }
  openTags.push(tagName);
  return rawTag;
}

function escapeUnsupportedTelegramHtml(
  text: string,
  support: TelegramHtmlTagSupport = TELEGRAM_LEGACY_HTML_TAG_SUPPORT,
): string {
  let result = "";
  let index = 0;
  const openTags: string[] = [];
  while (index < text.length) {
    const char = text[index];
    if (char === "&") {
      const entityEnd = findTelegramHtmlEntityEnd(text, index);
      if (entityEnd !== -1) {
        result += text.slice(index, entityEnd + 1);
        index = entityEnd + 1;
      } else {
        result += "&amp;";
        index += 1;
      }
      continue;
    }
    if (char === "<") {
      const end = text.indexOf(">", index + 1);
      if (end !== -1) {
        const rawTag = text.slice(index, end + 1);
        result += preserveTelegramHtmlTag(rawTag, openTags, escapeHtml, support);
        index = end + 1;
      } else {
        result += "&lt;";
        index += 1;
      }
      continue;
    }
    if (char === ">") {
      result += "&gt;";
      index += 1;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function stripTelegramHtmlForPlainText(html: string): string {
  return decodeTelegramHtmlEntities(
    html.replace(TELEGRAM_HTML_BREAK_PATTERN, "\n").replace(TELEGRAM_HTML_TAG_PATTERN, ""),
  );
}

function encodePlainTextForTelegramHtmlStrip(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

export function telegramHtmlToPlainTextFallback(html: string): string {
  const withPlainTables = html.replace(TELEGRAM_RICH_HTML_TABLE_PATTERN, (tableHtml) => {
    const rows = parseTelegramRichHtmlTableRows(tableHtml);
    return rows.map((row) => row.join(" | ")).join("\n");
  });
  TELEGRAM_HTML_ANCHOR_PATTERN.lastIndex = 0;
  const withPlainLinks = withPlainTables.replace(
    TELEGRAM_HTML_ANCHOR_PATTERN,
    (
      _match: string,
      doubleQuotedHref: string | undefined,
      singleQuotedHref: string | undefined,
      unquotedHref: string | undefined,
      labelHtml: string,
    ) => {
      const href = decodeTelegramHtmlEntities(
        doubleQuotedHref ?? singleQuotedHref ?? unquotedHref ?? "",
      ).trim();
      const label = stripTelegramHtmlForPlainText(labelHtml).trim();
      if (!href) {
        return encodePlainTextForTelegramHtmlStrip(label);
      }
      return encodePlainTextForTelegramHtmlStrip(
        !label || label === href ? href : `${label} (${href})`,
      );
    },
  );
  return stripTelegramHtmlForPlainText(withPlainLinks);
}

function promoteEscapedSupportedTelegramTags(
  text: string,
  openTags: string[],
  support: TelegramHtmlTagSupport,
): string {
  ESCAPED_HTML_TAG_PATTERN.lastIndex = 0;
  return text.replace(
    ESCAPED_HTML_TAG_PATTERN,
    (match, closing: string, name: string, attrs: string) =>
      preserveTelegramHtmlTag(`<${closing}${name}${attrs}>`, openTags, () => match, support),
  );
}

function preserveSupportedTelegramHtmlTags(
  html: string,
  support: TelegramHtmlTagSupport = TELEGRAM_LEGACY_HTML_TAG_SUPPORT,
): string {
  let codeDepth = 0;
  let preDepth = 0;
  let result = "";
  let lastIndex = 0;
  const openEscapedTags: string[] = [];

  for (const tag of tokenizeHtmlTags(html)) {
    const tagStart = tag.start;
    const tagEnd = tag.end;
    const tagName = tag.name;
    const isClosing = tag.closing;
    const textBefore = html.slice(lastIndex, tagStart);
    result +=
      codeDepth > 0 || preDepth > 0
        ? textBefore
        : promoteEscapedSupportedTelegramTags(textBefore, openEscapedTags, support);

    if (tagName === "code") {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else if (tagName === "pre") {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    }

    result += html.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }

  const remainingText = html.slice(lastIndex);
  result +=
    codeDepth > 0 || preDepth > 0
      ? remainingText
      : promoteEscapedSupportedTelegramTags(remainingText, openEscapedTags, support);
  return result;
}

function renderSupportedTelegramHtml(
  html: string,
  support: TelegramHtmlTagSupport = TELEGRAM_LEGACY_HTML_TAG_SUPPORT,
): string {
  return protectTelegramAssistantTranscriptRoleHeaders(
    preserveSupportedTelegramHtmlTags(html, support),
  );
}

function getFileReferencePattern(): RegExp {
  if (fileReferencePattern) {
    return fileReferencePattern;
  }
  const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
  fileReferencePattern = new RegExp(
    `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${fileExtensionsPattern}))(?=$|[^a-zA-Z0-9_\\-/])`,
    "gi",
  );
  return fileReferencePattern;
}

function getOrphanedTldPattern(): RegExp {
  if (orphanedTldPattern) {
    return orphanedTldPattern;
  }
  const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
  orphanedTldPattern = new RegExp(
    `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${fileExtensionsPattern}))(?=[^a-zA-Z0-9/]|$)`,
    "g",
  );
  return orphanedTldPattern;
}

function wrapStandaloneFileRef(match: string, prefix: string, filename: string): string {
  if (filename.startsWith("//")) {
    return match;
  }
  if (/https?:\/\/$/i.test(prefix)) {
    return match;
  }
  return `${prefix}<code>${escapeHtml(filename)}</code>`;
}

function wrapSegmentFileRefs(
  text: string,
  codeDepth: number,
  preDepth: number,
  anchorDepth: number,
): string {
  if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) {
    return text;
  }
  const wrappedStandalone = text.replace(getFileReferencePattern(), wrapStandaloneFileRef);
  return wrappedStandalone.replace(getOrphanedTldPattern(), (match, prefix: string, tld: string) =>
    prefix === ">" ? match : `${prefix}<code>${escapeHtml(tld)}</code>`,
  );
}

export function wrapFileReferencesInHtml(html: string): string {
  // Track nesting depth for tags that should not be modified
  let codeDepth = 0;
  let preDepth = 0;
  let anchorDepth = 0;
  let result = "";
  let lastIndex = 0;

  // Process tags token-by-token so we can skip protected regions while wrapping plain text.
  for (const tag of tokenizeHtmlTags(html)) {
    const tagStart = tag.start;
    const tagEnd = tag.end;
    const isClosing = tag.closing;
    const tagName = tag.name;

    // Process text before this tag
    const textBefore = html.slice(lastIndex, tagStart);
    result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);

    // Update tag depth (clamp at 0 for malformed HTML with stray closing tags)
    if (tagName === "code") {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else if (tagName === "pre") {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    } else if (tagName === "a") {
      anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
    }

    // Add the tag itself
    result += html.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }

  // Process remaining text
  const remainingText = html.slice(lastIndex);
  result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);

  return result;
}

export function renderTelegramHtmlText(
  text: string,
  options: { textMode?: "markdown" | "html"; tableMode?: MarkdownTableMode } = {},
): string {
  const textMode = options.textMode ?? "markdown";
  if (textMode === "html") {
    return escapeUnsupportedTelegramHtmlWithTableFallback(text);
  }
  // markdownToTelegramHtml already wraps file references by default
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

function escapeUnsupportedTelegramHtmlWithTableFallback(html: string): string {
  return escapeUnsupportedTelegramHtml(
    normalizeTelegramLegacyHtmlTables(html),
    TELEGRAM_LEGACY_HTML_TAG_SUPPORT,
  );
}

function isInsideTelegramHtmlCodeContext(html: string, offset: number): boolean {
  let codeDepth = 0;
  let preDepth = 0;
  for (const tag of tokenizeHtmlTags(html)) {
    if (tag.start >= offset) {
      break;
    }
    const tagName = tag.name;
    if (tagName !== "code" && tagName !== "pre") {
      continue;
    }
    const isClosing = tag.closing;
    if (tagName === "code") {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    }
  }
  return codeDepth > 0 || preDepth > 0;
}

function normalizeTelegramLegacyHtmlTables(html: string): string {
  TELEGRAM_RICH_HTML_TABLE_PATTERN.lastIndex = 0;
  return html.replace(TELEGRAM_RICH_HTML_TABLE_PATTERN, (tableHtml, offset: number) => {
    if (isInsideTelegramHtmlCodeContext(html, offset)) {
      return tableHtml;
    }
    const rows = parseTelegramRichHtmlTableRows(tableHtml);
    return rows.length ? renderTelegramRichHtmlRawTableFallback(tableHtml, rows) : tableHtml;
  });
}

function parseTelegramHtmlColspan(attrs: string): number {
  const raw = TELEGRAM_HTML_COLSPAN_PATTERN.exec(attrs)?.slice(1).find(Boolean);
  const value = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(value) && value > 1 ? Math.min(value, 21) : 1;
}

function parseTelegramRichHtmlTableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.lastIndex = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const row: string[] = [];
    TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.exec(rowHtml)) !== null) {
      const attrs = cellMatch[2] ?? "";
      const text = telegramHtmlToPlainTextFallback(cellMatch[3] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      row.push(text, ...Array.from({ length: parseTelegramHtmlColspan(attrs) - 1 }, () => ""));
    }
    if (row.length) {
      rows.push(row);
    }
  }
  return rows;
}

function renderTelegramRichHtmlRawTableFallback(
  tableHtml: string,
  rows: readonly string[][],
): string {
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 3);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index] ?? 3, row[index]?.length ?? 0);
    }
  }
  const caption =
    rows.length > 0
      ? telegramHtmlToPlainTextFallback(
          TELEGRAM_HTML_CAPTION_PATTERN.exec(tableHtml)?.[1] ?? "",
        ).trim()
      : "";
  const tableText =
    rows.length > 0
      ? rows
          .map(
            (row) =>
              `| ${widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" | ")} |`,
          )
          .join("\n")
      : stripTelegramHtmlForPlainText(tableHtml).trim();
  return `<pre><code>${escapeHtml([caption, tableText].filter(Boolean).join("\n"))}</code></pre>\n\n`;
}

type TelegramHtmlTag = {
  name: string;
  openTag: string;
  closeTag: string;
};

function buildTelegramHtmlOpenPrefix(tags: TelegramHtmlTag[]): string {
  return tags.map((tag) => tag.openTag).join("");
}

function buildTelegramHtmlCloseSuffix(tags: TelegramHtmlTag[]): string {
  return tags
    .slice()
    .toReversed()
    .map((tag) => tag.closeTag)
    .join("");
}

function buildTelegramHtmlCloseSuffixLength(tags: TelegramHtmlTag[]): number {
  return tags.reduce((total, tag) => total + tag.closeTag.length, 0);
}

// Never return a split index that lands between a UTF-16 surrogate pair, or
// both chunks would carry a lone surrogate that re-encodes to U+FFFD. If the
// pair starts the segment, keep it whole so chunking still advances.
function clampToSurrogateBoundary(text: string, index: number): number {
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  const splitsPair =
    index > 0 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  if (!splitsPair) {
    return index;
  }
  return index > 1 ? index - 1 : index + 1;
}

function findTelegramHtmlSafeSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return text.length;
  }
  const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
  const splitIndex = findTelegramHtmlEntitySafeSplitIndex(text, normalizedMaxLength);
  return clampToSurrogateBoundary(text, splitIndex);
}

function findTelegramHtmlEntitySafeSplitIndex(text: string, normalizedMaxLength: number): number {
  const lastAmpersand = text.lastIndexOf("&", normalizedMaxLength - 1);
  if (lastAmpersand === -1) {
    return normalizedMaxLength;
  }
  const lastSemicolon = text.lastIndexOf(";", normalizedMaxLength - 1);
  if (lastAmpersand < lastSemicolon) {
    return normalizedMaxLength;
  }
  const entityEnd = findTelegramHtmlEntityEnd(text, lastAmpersand);
  if (entityEnd === -1 || entityEnd < normalizedMaxLength) {
    return normalizedMaxLength;
  }
  return lastAmpersand;
}

function popTelegramHtmlTag(tags: TelegramHtmlTag[], name: string): void {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    if (tags[index]?.name === name) {
      tags.splice(index, 1);
      return;
    }
  }
}

function splitTelegramHtmlChunksRaw(html: string, limit: number): string[] {
  if (!html) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (html.length <= normalizedLimit) {
    return [html];
  }

  const chunks: string[] = [];
  const openTags: TelegramHtmlTag[] = [];
  const suppressedTagNames: string[] = [];
  let current = "";
  let chunkHasPayload = false;

  const resetCurrent = () => {
    current = buildTelegramHtmlOpenPrefix(openTags);
    chunkHasPayload = false;
  };

  const flushCurrent = () => {
    if (!chunkHasPayload) {
      return;
    }
    chunks.push(`${current}${buildTelegramHtmlCloseSuffix(openTags)}`);
    resetCurrent();
  };

  const appendText = (segment: string) => {
    let remaining = segment;
    while (remaining.length > 0) {
      const available =
        normalizedLimit - current.length - buildTelegramHtmlCloseSuffixLength(openTags);
      if (available <= 0) {
        if (!chunkHasPayload) {
          // Preserve the matching closes separately when tag overhead alone
          // fills a chunk. Dropping only this active scope keeps later tags
          // balanced while the affected text degrades to plain HTML content.
          suppressedTagNames.push(...openTags.map((tag) => tag.name));
          openTags.length = 0;
          resetCurrent();
          continue;
        }
        flushCurrent();
        continue;
      }
      if (remaining.length <= available) {
        current += remaining;
        chunkHasPayload = true;
        break;
      }
      const splitAt = findTelegramHtmlSafeSplitIndex(remaining, available);
      if (splitAt <= 0) {
        if (!chunkHasPayload) {
          throw new Error(
            `Telegram HTML chunk limit exceeded by leading entity (limit=${normalizedLimit})`,
          );
        }
        flushCurrent();
        continue;
      }
      current += remaining.slice(0, splitAt);
      chunkHasPayload = true;
      remaining = remaining.slice(splitAt);
      flushCurrent();
    }
  };

  resetCurrent();
  let lastIndex = 0;
  for (const tag of tokenizeHtmlTags(html)) {
    const tagStart = tag.start;
    const tagEnd = tag.end;
    appendText(html.slice(lastIndex, tagStart));

    const rawTag = tag.raw;
    const isClosing = tag.closing;
    const tagName = tag.name;
    const isSelfClosing = !isClosing && rawTag.trimEnd().endsWith("/>");

    if (!isClosing) {
      const nextCloseLength = isSelfClosing ? 0 : `</${tagName}>`.length;
      if (
        chunkHasPayload &&
        current.length +
          rawTag.length +
          buildTelegramHtmlCloseSuffixLength(openTags) +
          nextCloseLength >
          normalizedLimit
      ) {
        flushCurrent();
      }
    }

    const closesOpenTag = isClosing && openTags.some((openTag) => openTag.name === tagName);
    const closesSuppressedTag =
      isClosing && !closesOpenTag && popLastTagName(suppressedTagNames, tagName);
    if (!closesSuppressedTag) {
      current += rawTag;
    }
    if (isSelfClosing) {
      chunkHasPayload = true;
    }
    if (isClosing) {
      popTelegramHtmlTag(openTags, tagName);
    } else if (!isSelfClosing) {
      openTags.push({
        name: tagName,
        openTag: rawTag,
        closeTag: `</${tagName}>`,
      });
    }
    lastIndex = tagEnd;
  }

  appendText(html.slice(lastIndex));
  flushCurrent();
  return chunks.length > 0 ? chunks : [html];
}

export function splitTelegramHtmlChunks(html: string, limit: number): string[] {
  const chunks = splitTelegramHtmlChunksRaw(html, limit);
  if (chunks.every((chunk) => protectTelegramAssistantTranscriptRoleHeaders(chunk) === chunk)) {
    return chunks;
  }

  const normalizedLimit = Math.max(1, Math.floor(limit));
  const protectedContentLimit = normalizedLimit - TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX.length;
  if (protectedContentLimit < 1) {
    throw new Error(
      `Telegram HTML chunk limit cannot fit assistant transcript marker (limit=${normalizedLimit})`,
    );
  }
  return splitTelegramHtmlChunksRaw(html, protectedContentLimit).map((chunk) =>
    protectTelegramAssistantTranscriptRoleHeaders(chunk),
  );
}

function renderTelegramChunkHtml(ir: MarkdownIR): string {
  return wrapFileReferencesInHtml(renderSupportedTelegramHtml(renderTelegramHtml(ir)));
}

function renderTelegramChunksWithinHtmlLimit(
  ir: MarkdownIR,
  limit: number,
): TelegramFormattedChunk[] {
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk: renderTelegramChunkHtml,
    measureRendered: (html) => html.length,
  }).map(({ source, rendered }) => ({
    html: rendered,
    text: source.text,
  }));
}

export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): TelegramFormattedChunk[] {
  const ir = markdownToIR(preserveTelegramListBoundarySpacing(markdown ?? ""), {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  return renderTelegramChunksWithinHtmlLimit(ir, limit);
}

export function markdownToTelegramHtmlChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): string[] {
  return markdownToTelegramChunks(markdown, limit, options).map((chunk) => chunk.html);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
