import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
// Telegram helper module supports format behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FILE_REF_EXTENSIONS_WITH_TLD,
  isAutoLinkedFileRef,
  markdownToIR,
  markdownToIRWithMeta,
  type MarkdownLinkSpan,
  type MarkdownIR,
  type MarkdownTableCell,
  type MarkdownTableMeta,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
  sliceMarkdownIR,
} from "openclaw/plugin-sdk/text-chunking";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

const TELEGRAM_RICH_NESTING_LIMIT = 16;

export type TelegramRichHtmlDegradationReason = "table-ascii";

type TelegramOutboundRichHtmlNormalization = {
  html: string;
  degradationReasons: readonly TelegramRichHtmlDegradationReason[];
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
function buildTelegramLink(link: MarkdownLinkSpan, text: string) {
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
  if (isAutoLinkedFileRef(href, label)) {
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
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: buildTelegramCodeBlockOpen, close: "</code></pre>" },
      spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
      blockquote: { open: "<blockquote>", close: "</blockquote>" },
      heading_1: { open: "<h1>", close: "</h1>" },
      heading_2: { open: "<h2>", close: "</h2>" },
      heading_3: { open: "<h3>", close: "</h3>" },
      heading_4: { open: "<h4>", close: "</h4>" },
      heading_5: { open: "<h5>", close: "</h5>" },
      heading_6: { open: "<h6>", close: "</h6>" },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
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
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode,
  });
  const html = renderTelegramHtml(ir);
  const telegramHtml = preserveSupportedTelegramHtmlTags(html);
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

const AUTO_LINKED_ANCHOR_PATTERN = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;
const HTML_MODE_TAG_PATTERN = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>$/;
const ESCAPED_HTML_TAG_PATTERN = /&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)(.*?)&gt;/g;
const TELEGRAM_HTML_ANCHOR_PATTERN =
  /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const TELEGRAM_HTML_BREAK_PATTERN = /<br\s*\/?>/gi;
const TELEGRAM_HTML_ENTITY_PATTERN = /&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g;
const TELEGRAM_HTML_TAG_PATTERN = /<[^>]*>/g;
const TELEGRAM_RICH_MEDIA_BLOCK_PATTERN =
  /[^\S\r\n]*(?:<figure\b[^>]*>[\s\S]*?<\/figure>|<tg-collage\b[^>]*>[\s\S]*?<\/tg-collage>|<tg-slideshow\b[^>]*>[\s\S]*?<\/tg-slideshow>|<img\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*\/?>|<video\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*(?:\/>|>[\s\S]*?<\/video>)|<audio\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*(?:\/>|>[\s\S]*?<\/audio>)|<tg-map\b[^>]*\/?>)[^\S\r\n]*/gi;
const TELEGRAM_RICH_HTML_TABLE_PATTERN = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
const TELEGRAM_CANONICAL_RICH_HTML_TABLE_PATTERN = /^<table bordered striped>/i;
const TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const TELEGRAM_HTML_CAPTION_PATTERN = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i;
const TELEGRAM_HTML_COLSPAN_PATTERN = /\bcolspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i;
const TELEGRAM_HTML_ROWSPAN_PATTERN = /\browspan\s*=/i;
const TELEGRAM_HTML_ALIGN_PATTERN =
  /\balign\s*=\s*(?:"(left|center|right)"|'(left|center|right)'|(left|center|right))/i;
const TELEGRAM_MARKDOWN_MEDIA_BLOCK_PATTERN =
  /^([ \t]*)!\[([^\]\n]*)\]\((https?:\/\/[^\s)"]+)(?:\s+"([^"\n]*)")?\)[ \t]*$/;
const TELEGRAM_MARKDOWN_INLINE_IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const TELEGRAM_MARKDOWN_REFERENCE_IMAGE_PATTERN = /!\[([^\]\n]*)\]\[([^\]\n]+)\]/g;
const TELEGRAM_MARKDOWN_MEDIA_PLACEHOLDER_PREFIX = "\uE000telegram-media:";
const TELEGRAM_MARKDOWN_MEDIA_PLACEHOLDER_SUFFIX = "\uE001";
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
  ["tg-time", /^\s+datetime="[^"]+"\s*$/],
  ["blockquote", /^(\s+expandable)?\s*$/],
]);
const TELEGRAM_CODE_LANGUAGE_ATTR_PATTERN = /^\s+class="language-[^"]+"\s*$/;
const TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT = 20;
const TELEGRAM_VOID_HTML_TAGS = new Set(["br", "hr", "img", "input", "tg-map"]);
const TELEGRAM_RICH_BLOCK_HTML_TAGS = new Set([
  "aside",
  "audio",
  "blockquote",
  "details",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tg-collage",
  "tg-map",
  "tg-math-block",
  "tg-slideshow",
  "tr",
  "ul",
  "video",
]);
const TELEGRAM_RICH_MEDIA_HTML_TAGS = new Set(["audio", "img", "video"]);
const TELEGRAM_RICH_SIMPLE_HTML_TAGS = new Set([
  ...TELEGRAM_SIMPLE_HTML_TAGS,
  "a",
  "aside",
  "audio",
  "blockquote",
  "br",
  "caption",
  "cite",
  "details",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "mark",
  "ol",
  "p",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tg-collage",
  "tg-math",
  "tg-math-block",
  "tg-slideshow",
  "th",
  "thead",
  "tr",
  "ul",
  "video",
]);
const TELEGRAM_RICH_ATTR_HTML_TAG_PATTERNS = new Map([
  ...TELEGRAM_ATTR_HTML_TAG_PATTERNS,
  ["a", /^\s+(?:href|name)="[^"]+"\s*$/],
  [
    "audio",
    /^(?=.*\ssrc="https?:\/\/[^"]+")(?:\s+src="https?:\/\/[^"]+"|\s+title="[^"]*")*\s*\/?\s*$/,
  ],
  ["details", /^\s+open\s*$/],
  ["figure", /^\s+tg-spoiler\s*$/],
  [
    "img",
    /^(?=.*\ssrc="https?:\/\/[^"]+")(?:\s+src="https?:\/\/[^"]+"|\s+(?:alt|title)="[^"]*"|\s+tg-spoiler)*\s*\/?\s*$/,
  ],
  ["input", /^\s+type="checkbox"(?:\s+checked)?\s*\/?\s*$/],
  ["li", /^(?:\s+(?:value|type)="[^"]*")*\s*$/],
  ["ol", /^(?:\s+(?:start|type)="[^"]*"|\s+reversed)*\s*$/],
  ["table", /^(?:\s+(?:bordered|striped))*\s*$/],
  [
    "td",
    /^(?:\s+(?:colspan|rowspan)="[1-9]\d*"|\s+align="(?:left|center|right)"|\s+valign="(?:top|middle|bottom)")*\s*$/,
  ],
  ["tg-emoji", /^\s+emoji-id="[^"]+"\s*$/],
  ["tg-map", /^\s+lat="[^"]+"\s+long="[^"]+"(?:\s+zoom="[^"]+")?\s*\/?\s*$/],
  ["tg-reference", /^\s+name="[^"]+"\s*$/],
  ["tg-time", /^\s+unix="[^"]+"(?:\s+format="[^"]+")?\s*$/],
  [
    "th",
    /^(?:\s+(?:colspan|rowspan)="[1-9]\d*"|\s+align="(?:left|center|right)"|\s+valign="(?:top|middle|bottom)")*\s*$/,
  ],
  [
    "video",
    /^(?=.*\ssrc="https?:\/\/[^"]+")(?:\s+src="https?:\/\/[^"]+"|\s+title="[^"]*"|\s+tg-spoiler)*\s*\/?\s*$/,
  ],
]);
let fileReferencePattern: RegExp | undefined;
let orphanedTldPattern: RegExp | undefined;

type TelegramHtmlTagSupport = {
  simpleTags: ReadonlySet<string>;
  attrPatterns: ReadonlyMap<string, RegExp>;
};

type TelegramTableAlignment = NonNullable<MarkdownTableMeta["aligns"]>[number];

const TELEGRAM_LEGACY_HTML_TAG_SUPPORT: TelegramHtmlTagSupport = {
  simpleTags: TELEGRAM_SIMPLE_HTML_TAGS,
  attrPatterns: TELEGRAM_ATTR_HTML_TAG_PATTERNS,
};

const TELEGRAM_RICH_HTML_TAG_SUPPORT: TelegramHtmlTagSupport = {
  simpleTags: TELEGRAM_RICH_SIMPLE_HTML_TAGS,
  attrPatterns: TELEGRAM_RICH_ATTR_HTML_TAG_PATTERNS,
};

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
  if (TELEGRAM_VOID_HTML_TAGS.has(tagName) || rawTag.trimEnd().endsWith("/>")) {
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

function isValidTelegramHtmlEntityCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function decodeTelegramHtmlEntity(entity: string, fallback: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  if (entity.startsWith("#")) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return isValidTelegramHtmlEntityCodePoint(codePoint)
      ? String.fromCodePoint(codePoint)
      : fallback;
  }
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default:
      return fallback;
  }
}

function decodeTelegramHtmlEntities(text: string): string {
  return text.replace(TELEGRAM_HTML_ENTITY_PATTERN, (match, entity: string) =>
    decodeTelegramHtmlEntity(entity, match),
  );
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

  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);
    const isClosing = match[1] === "</";
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
  // Safety-net: de-linkify auto-generated anchors where href="http://<label>" (defense in depth for textMode: "html")
  AUTO_LINKED_ANCHOR_PATTERN.lastIndex = 0;
  const deLinkified = html.replace(AUTO_LINKED_ANCHOR_PATTERN, (_match, label: string) => {
    if (!isAutoLinkedFileRef(`http://${label}`, label)) {
      return _match;
    }
    return `<code>${escapeHtml(label)}</code>`;
  });

  // Track nesting depth for tags that should not be modified
  let codeDepth = 0;
  let preDepth = 0;
  let anchorDepth = 0;
  let result = "";
  let lastIndex = 0;

  // Process tags token-by-token so we can skip protected regions while wrapping plain text.
  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HTML_TAG_PATTERN.exec(deLinkified)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const isClosing = match[1] === "</";
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);

    // Process text before this tag
    const textBefore = deLinkified.slice(lastIndex, tagStart);
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
    result += deLinkified.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }

  // Process remaining text
  const remainingText = deLinkified.slice(lastIndex);
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

export function normalizeTelegramOutboundRichHtml(
  html: string,
): TelegramOutboundRichHtmlNormalization {
  const tableNormalized = normalizeTelegramRichHtmlTables(html);
  // This is the Bot API 10.1 rich-message wire contract. A second send-side
  // sanitizer would let raw tables or silent drops drift between send funnels.
  const safeHtml = limitTelegramRichHtmlNesting(
    materializeTelegramRichHtmlLineBreaks(
      normalizeTelegramRichLiteralWhitespaceEscapes(
        isolateTelegramRichMediaBlocks(
          escapeUnsupportedTelegramHtml(tableNormalized.html, TELEGRAM_RICH_HTML_TAG_SUPPORT),
        ),
      ),
    ),
    TELEGRAM_RICH_NESTING_LIMIT,
  );
  return {
    html: safeHtml,
    degradationReasons: tableNormalized.degradationReasons,
  };
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
  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null && match.index < offset) {
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);
    if (tagName !== "code" && tagName !== "pre") {
      continue;
    }
    const isClosing = match[1] === "</";
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

function limitTelegramRichHtmlNesting(html: string, maxDepth: number): string {
  const normalizedMaxDepth = Math.max(1, Math.floor(maxDepth));
  const stack: Array<{ name: string; kept: boolean }> = [];
  let keptDepth = 0;
  let output = "";
  let lastIndex = 0;

  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    output += html.slice(lastIndex, match.index);
    const rawTag = match[0];
    const isClosing = match[1] === "</";
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);
    const isSelfClosing =
      !isClosing && (TELEGRAM_VOID_HTML_TAGS.has(tagName) || rawTag.trimEnd().endsWith("/>"));

    if (isClosing) {
      const entryIndex = stack.findLastIndex((entry) => entry.name === tagName);
      if (entryIndex >= 0) {
        const [entry] = stack.splice(entryIndex, 1);
        if (entry?.kept) {
          keptDepth = Math.max(0, keptDepth - 1);
          output += rawTag;
        }
      }
    } else if (isSelfClosing) {
      if (tagName === "br" || keptDepth < normalizedMaxDepth) {
        output += rawTag;
      }
    } else {
      const kept = keptDepth < normalizedMaxDepth;
      stack.push({ name: tagName, kept });
      if (kept) {
        keptDepth += 1;
        output += rawTag;
      }
    }
    lastIndex = HTML_TAG_PATTERN.lastIndex;
  }
  return output + html.slice(lastIndex);
}

function normalizeTelegramRichMediaBlock(block: string): string {
  const normalized = block
    .trim()
    .replace(/<img\b([^>]*?)(\s*)>/gi, (_match, attrs: string, trailing: string) =>
      attrs.trimEnd().endsWith("/") ? `<img${attrs}${trailing}>` : `<img${attrs}${trailing}/>`,
    );
  return /^<(?:img|video|audio)\b/i.test(normalized)
    ? `<figure>${normalized}</figure>`
    : normalized;
}

function isolateTelegramRichMediaBlocks(html: string): string {
  return html
    .replace(
      TELEGRAM_RICH_MEDIA_BLOCK_PATTERN,
      (match) => `\n\n${normalizeTelegramRichMediaBlock(match)}\n\n`,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTelegramHtmlColspan(attrs: string): number {
  const raw = TELEGRAM_HTML_COLSPAN_PATTERN.exec(attrs)?.slice(1).find(Boolean);
  const value = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(value) && value > 1
    ? Math.min(value, TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT + 1)
    : 1;
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

function emptyTelegramTableCell(text: string): MarkdownTableCell {
  return {
    text,
    styles: [],
    links: [],
  };
}

type TelegramRawRichHtmlTableMeta = MarkdownTableMeta & {
  caption?: string;
  rawRichHtmlTable?: true;
};

type TelegramRawRichHtmlTableCell = MarkdownTableCell & {
  align?: TelegramTableAlignment;
  colspan?: number;
};

function parseTelegramHtmlAlign(attrs: string): TelegramTableAlignment | undefined {
  return TELEGRAM_HTML_ALIGN_PATTERN.exec(attrs)?.slice(1).find(Boolean) as
    | TelegramTableAlignment
    | undefined;
}

function parseTelegramRichHtmlTableAligns(
  tableHtml: string,
): (TelegramTableAlignment | undefined)[] {
  TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.lastIndex = 0;
  const firstRow = TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.exec(tableHtml)?.[1] ?? "";
  const aligns: (TelegramTableAlignment | undefined)[] = [];
  TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.lastIndex = 0;
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.exec(firstRow)) !== null) {
    const attrs = cellMatch[2] ?? "";
    aligns.push(
      ...Array.from({ length: parseTelegramHtmlColspan(attrs) }, () =>
        parseTelegramHtmlAlign(attrs),
      ),
    );
  }
  return aligns;
}

function parseTelegramRichHtmlTableCaption(tableHtml: string): string | undefined {
  const caption = telegramHtmlToPlainTextFallback(
    TELEGRAM_HTML_CAPTION_PATTERN.exec(tableHtml)?.[1] ?? "",
  ).trim();
  return caption || undefined;
}

function parseTelegramRichHtmlTableCellRows(tableHtml: string): TelegramRawRichHtmlTableCell[][] {
  const rows: TelegramRawRichHtmlTableCell[][] = [];
  TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.lastIndex = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = TELEGRAM_RICH_HTML_TABLE_ROW_PATTERN.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const row: TelegramRawRichHtmlTableCell[] = [];
    TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = TELEGRAM_RICH_HTML_TABLE_CELL_PATTERN.exec(rowHtml)) !== null) {
      const attrs = cellMatch[2] ?? "";
      const text = telegramHtmlToPlainTextFallback(cellMatch[3] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const colspan = parseTelegramHtmlColspan(attrs);
      const align = parseTelegramHtmlAlign(attrs);
      row.push({
        ...emptyTelegramTableCell(text),
        ...(align ? { align } : {}),
        ...(colspan > 1 ? { colspan } : {}),
      });
    }
    if (row.length) {
      rows.push(row);
    }
  }
  return rows;
}

function buildTelegramRichHtmlTableMeta(
  tableHtml: string,
  rows: readonly string[][],
): TelegramRawRichHtmlTableMeta {
  const [headers = [], ...bodyRows] = rows;
  const [headerCells = headers.map(emptyTelegramTableCell), ...rowCells] =
    parseTelegramRichHtmlTableCellRows(tableHtml);
  const caption = parseTelegramRichHtmlTableCaption(tableHtml);
  return {
    headers: [...headers],
    rows: bodyRows.map((row) => row.slice()),
    aligns: parseTelegramRichHtmlTableAligns(tableHtml),
    ...(caption ? { caption } : {}),
    rawRichHtmlTable: true,
    placeholderOffset: 0,
    headerCells,
    rowCells,
  };
}

function normalizeTelegramRichHtmlTables(html: string): TelegramOutboundRichHtmlNormalization {
  const degradationReasons = new Set<TelegramRichHtmlDegradationReason>();
  TELEGRAM_RICH_HTML_TABLE_PATTERN.lastIndex = 0;
  const normalizedHtml = html.replace(TELEGRAM_RICH_HTML_TABLE_PATTERN, (tableHtml) => {
    if (TELEGRAM_CANONICAL_RICH_HTML_TABLE_PATTERN.test(tableHtml)) {
      return tableHtml;
    }
    const rows = parseTelegramRichHtmlTableRows(tableHtml);
    const columnCount = Math.max(...rows.map((row) => row.length), 0);
    if (
      !rows.length ||
      columnCount > TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT ||
      TELEGRAM_HTML_ROWSPAN_PATTERN.test(tableHtml)
    ) {
      degradationReasons.add("table-ascii");
      return renderTelegramRichHtmlRawTableFallback(tableHtml, rows);
    }
    return renderTelegramRichHtmlTable(buildTelegramRichHtmlTableMeta(tableHtml, rows));
  });
  return {
    html: normalizedHtml,
    degradationReasons: [...degradationReasons],
  };
}

type TelegramRichMarkdownMediaNormalization = {
  markdown: string;
  mediaBlocks: string[];
};

function buildTelegramRichMarkdownMediaPlaceholder(index: number): string {
  return `${TELEGRAM_MARKDOWN_MEDIA_PLACEHOLDER_PREFIX}${index}${TELEGRAM_MARKDOWN_MEDIA_PLACEHOLDER_SUFFIX}`;
}

function replaceTelegramRichMarkdownMediaPlaceholders(
  html: string,
  mediaBlocks: readonly string[],
): string {
  let result = html;
  for (const [index, block] of mediaBlocks.entries()) {
    result = result.replaceAll(buildTelegramRichMarkdownMediaPlaceholder(index), block);
  }
  return result;
}

function normalizeTelegramRichMarkdownMedia(
  markdown: string,
): TelegramRichMarkdownMediaNormalization {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const mediaBlocks: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const match = inFence ? null : TELEGRAM_MARKDOWN_MEDIA_BLOCK_PATTERN.exec(line);
    if (inFence) {
      out.push(line);
      continue;
    }
    if (!match) {
      out.push(
        line
          .replace(TELEGRAM_MARKDOWN_INLINE_IMAGE_PATTERN, "[$1]($2)")
          .replace(TELEGRAM_MARKDOWN_REFERENCE_IMAGE_PATTERN, "[$1][$2]"),
      );
      continue;
    }
    const indent = expectDefined(match[1], "rich Markdown media indent capture");
    const alt = match[2];
    const src = expectDefined(match[3], "rich Markdown media source capture");
    const caption = match[4];
    const img = `<img src="${escapeHtmlAttr(src)}"${alt ? ` alt="${escapeHtmlAttr(alt)}"` : ""}/>`;
    const figcaption = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
    const placeholder = buildTelegramRichMarkdownMediaPlaceholder(mediaBlocks.length);
    mediaBlocks.push(`<figure>${img}${figcaption}</figure>`);
    out.push(`${indent}${placeholder}`);
  }
  return { markdown: out.join("\n"), mediaBlocks };
}

function renderTelegramRichHtmlTableFallback(table: MarkdownTableMeta): string {
  const rows = [table.headers, ...table.rows];
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 3);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index] ?? 3, row[index]?.length ?? 0);
    }
  }
  const renderRow = (row: readonly string[]) =>
    `| ${widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  const tableText = [renderRow(table.headers), divider, ...table.rows.map(renderRow)].join("\n");
  return `<pre><code>${escapeHtml(tableText)}</code></pre>\n\n`;
}

function renderTelegramRichHtmlTable(table: MarkdownTableMeta): string {
  const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);
  if (columnCount > TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT) {
    return renderTelegramRichHtmlTableFallback(table);
  }
  const isRawRichHtmlTable = "rawRichHtmlTable" in table && table.rawRichHtmlTable === true;
  const rawCaption =
    "caption" in table && typeof table.caption === "string" ? table.caption.trim() : "";
  const caption = rawCaption ? `<caption>${escapeHtml(rawCaption)}</caption>` : "";
  const renderCellValue = (cell: MarkdownTableCell | undefined) =>
    cell ? renderTelegramHtml(cell) : "";
  const renderCell = (
    tag: "td" | "th",
    value: MarkdownTableCell | undefined,
    align: TelegramTableAlignment | undefined,
  ) => {
    const rawCell = value as TelegramRawRichHtmlTableCell | undefined;
    const alignValue = rawCell?.align ?? align;
    const alignAttr = alignValue ? ` align="${alignValue}"` : "";
    const colspanAttr = rawCell?.colspan ? ` colspan="${rawCell.colspan}"` : "";
    return `<${tag}${alignAttr}${colspanAttr}>${renderCellValue(value)}</${tag}>`;
  };
  const head = table.headers.length
    ? `<thead><tr>${
        isRawRichHtmlTable
          ? table.headerCells.map((cell) => renderCell("th", cell, undefined)).join("")
          : table.headerCells
              .map((cell, index) => renderCell("th", cell, table.aligns?.[index]))
              .join("")
      }</tr></thead>`
    : "";
  const bodyRows = isRawRichHtmlTable
    ? table.rowCells
        .map((row) => `<tr>${row.map((cell) => renderCell("td", cell, undefined)).join("")}</tr>`)
        .join("")
    : table.rowCells
        .map(
          (row) =>
            `<tr>${Array.from({ length: columnCount }, (_value, index) => renderCell("td", row[index], table.aligns?.[index])).join("")}</tr>`,
        )
        .join("");
  const body = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
  return `<table bordered striped>${caption}${head}${body}</table>\n\n`;
}

function renderTelegramRichHtmlDocument(
  ir: MarkdownIR,
  tables: readonly MarkdownTableMeta[],
): string {
  if (!tables.length) {
    return isolateTelegramRichMediaBlocks(
      wrapFileReferencesInHtml(
        preserveSupportedTelegramHtmlTags(renderTelegramHtml(ir), TELEGRAM_RICH_HTML_TAG_SUPPORT),
      ),
    );
  }
  let cursor = 0;
  let html = "";
  for (const table of [...tables].toSorted(
    (left, right) => left.placeholderOffset - right.placeholderOffset,
  )) {
    const offset = Math.max(cursor, Math.min(table.placeholderOffset, ir.text.length));
    html += renderTelegramHtml(sliceMarkdownIR(ir, cursor, offset));
    html += renderTelegramRichHtmlTable(table);
    cursor = offset;
  }
  html += renderTelegramHtml(sliceMarkdownIR(ir, cursor, ir.text.length));
  return isolateTelegramRichMediaBlocks(
    wrapFileReferencesInHtml(
      preserveSupportedTelegramHtmlTags(html, TELEGRAM_RICH_HTML_TAG_SUPPORT),
    ),
  );
}

function convertTelegramRichSegmentNewlines(
  segment: string,
  prevStructural: boolean,
  nextStructural: boolean,
): string {
  if (!segment.includes("\n")) {
    return segment;
  }
  // Keep newline runs that hug a structural tag: Telegram already starts a new
  // line there, so a stray <br> would add a blank line or land as an invalid
  // child inside a container (table/figure/details/list).
  return segment.replace(/\n+/g, (run: string, offset: number) => {
    const hugsPrev = offset === 0 && prevStructural;
    const hugsNext = offset + run.length === segment.length && nextStructural;
    return hugsPrev || hugsNext ? run : "<br>".repeat(run.length);
  });
}

// Tags whose inner whitespace Telegram renders verbatim, so their newlines stay
// literal: code/pre keep source formatting and math holds raw LaTeX.
const TELEGRAM_RICH_LITERAL_WHITESPACE_TAGS = new Set(["code", "pre", "tg-math", "tg-math-block"]);

// Structural tags whose surrounding/inner newlines are layout whitespace, not
// prose: the rich block set plus the table/figure/details container children
// that TELEGRAM_RICH_BLOCK_HTML_TAGS omits (it is tuned for chunk block
// counting). A <br> wedged between these would be an invalid container child or
// a stray blank line, so their boundary newlines stay literal.
const TELEGRAM_RICH_LINE_BREAK_STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  ...TELEGRAM_RICH_BLOCK_HTML_TAGS,
  "caption",
  "col",
  "colgroup",
  "figcaption",
  "summary",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
]);

function isTelegramRichLineBreakStructuralTag(rawTag: string, tagName: string): boolean {
  return (
    TELEGRAM_RICH_LINE_BREAK_STRUCTURAL_TAGS.has(tagName) ||
    (tagName === "a" && /\sname="[^"]+"/i.test(rawTag))
  );
}

function normalizeTelegramRichLiteralWhitespaceEscapes(html: string): string {
  if (!html.includes("\\n") && !html.includes("\\t")) {
    return html;
  }
  let result = "";
  let lastIndex = 0;
  let literalDepth = 0;

  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const rawTag = match[0];
    const isClosing = match[1] === "</";
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);
    const segment = html.slice(lastIndex, tagStart);
    result += literalDepth > 0 ? segment : materializeTelegramRichLiteralWhitespace(segment);

    if (TELEGRAM_RICH_LITERAL_WHITESPACE_TAGS.has(tagName) && !rawTag.trimEnd().endsWith("/>")) {
      literalDepth = isClosing ? Math.max(0, literalDepth - 1) : literalDepth + 1;
    }
    result += rawTag;
    lastIndex = tagEnd;
  }

  const tail = html.slice(lastIndex);
  result += literalDepth > 0 ? tail : materializeTelegramRichLiteralWhitespace(tail);
  return result;
}

function materializeTelegramRichLiteralWhitespace(segment: string): string {
  return segment.replace(/\\[nt]/g, (match) => (match === "\\n" ? "\n" : "\t"));
}

// Bot API 10.1 rich messages parse structured HTML, so literal newlines are
// insignificant whitespace — unlike the legacy HTML parse mode that renders them
// as line breaks. Materialize inline newlines as <br> so multi-line prose and
// bullet runs keep their breaks, while leaving newlines literal inside
// code/pre/math and where they only separate block-level tags.
export function materializeTelegramRichHtmlLineBreaks(html: string): string {
  if (!html.includes("\n")) {
    return html;
  }
  let result = "";
  let lastIndex = 0;
  let literalDepth = 0;
  let prevStructural = false;

  HTML_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const rawTag = match[0];
    const isClosing = match[1] === "</";
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);
    // <br> already emits a break, so treat it like a structural boundary: a
    // hugging newline stays literal instead of doubling into a blank line.
    const tagIsStructural =
      tagName === "br" || isTelegramRichLineBreakStructuralTag(rawTag, tagName);
    const segment = html.slice(lastIndex, tagStart);
    result +=
      literalDepth > 0
        ? segment
        : convertTelegramRichSegmentNewlines(segment, prevStructural, tagIsStructural);

    // Self-closing literal tags (e.g. a stray <pre/>) must not open a region that
    // never closes and swallows every later line break.
    if (TELEGRAM_RICH_LITERAL_WHITESPACE_TAGS.has(tagName) && !rawTag.trimEnd().endsWith("/>")) {
      literalDepth = isClosing ? Math.max(0, literalDepth - 1) : literalDepth + 1;
    }
    result += rawTag;
    lastIndex = tagEnd;
    prevStructural = tagIsStructural;
  }

  const tail = html.slice(lastIndex);
  result +=
    literalDepth > 0 ? tail : convertTelegramRichSegmentNewlines(tail, prevStructural, false);
  return result;
}

export function markdownToTelegramRichHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; skipEntityDetection?: boolean } = {},
): string {
  const tableMode = options.tableMode ?? "block";
  const normalized = normalizeTelegramRichMarkdownMedia(markdown ?? "");
  const { ir, tables } = markdownToIRWithMeta(
    preserveTelegramListBoundarySpacing(normalized.markdown),
    {
      linkify: options.skipEntityDetection !== true,
      enableSpoilers: true,
      headingStyle: "rich",
      blockquotePrefix: "",
      tableMode,
    },
  );
  return isolateTelegramRichMediaBlocks(
    replaceTelegramRichMarkdownMediaPlaceholders(
      renderTelegramRichHtmlDocument(ir, tables),
      normalized.mediaBlocks,
    ),
  );
}

type TelegramHtmlTag = {
  name: string;
  openTag: string;
  closeTag: string;
  richBlock: boolean;
  richMedia: boolean;
};

const TELEGRAM_SELF_CLOSING_HTML_TAGS = TELEGRAM_VOID_HTML_TAGS;

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

function isTelegramRichBlockHtmlTag(rawTag: string, tagName: string): boolean {
  return (
    TELEGRAM_RICH_BLOCK_HTML_TAGS.has(tagName) ||
    (tagName === "a" && /\sname="[^"]+"/i.test(rawTag))
  );
}

function findTelegramHtmlEntityEnd(text: string, start: number): number {
  if (text[start] !== "&") {
    return -1;
  }
  let index = start + 1;
  if (index >= text.length) {
    return -1;
  }
  if (text[index] === "#") {
    index += 1;
    if (index >= text.length) {
      return -1;
    }
    const isHex = text[index] === "x" || text[index] === "X";
    if (isHex) {
      index += 1;
      const hexStart = index;
      while (/[0-9A-Fa-f]/.test(text[index] ?? "")) {
        index += 1;
      }
      if (index === hexStart) {
        return -1;
      }
    } else {
      const digitStart = index;
      while (/[0-9]/.test(text[index] ?? "")) {
        index += 1;
      }
      if (index === digitStart) {
        return -1;
      }
    }
  } else {
    const nameStart = index;
    while (/[A-Za-z0-9]/.test(text[index] ?? "")) {
      index += 1;
    }
    if (index === nameStart) {
      return -1;
    }
  }
  return text[index] === ";" ? index : -1;
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

export function splitTelegramHtmlChunks(
  html: string,
  limit: number,
  options: { blockLimit?: number; mediaLimit?: number } = {},
): string[] {
  if (!html) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const blockLimit =
    options.blockLimit == null ? undefined : Math.max(1, Math.floor(options.blockLimit));
  const mediaLimit =
    options.mediaLimit == null ? undefined : Math.max(1, Math.floor(options.mediaLimit));
  if (html.length <= normalizedLimit && blockLimit === undefined && mediaLimit === undefined) {
    return [html];
  }

  const chunks: string[] = [];
  const openTags: TelegramHtmlTag[] = [];
  const suppressedTagNames: string[] = [];
  let current = "";
  let currentBlockCount = 0;
  let currentMediaCount = 0;
  let chunkHasPayload = false;

  const resetCurrent = () => {
    current = buildTelegramHtmlOpenPrefix(openTags);
    currentBlockCount = openTags.filter((tag) => tag.richBlock).length;
    currentMediaCount = openTags.filter((tag) => tag.richMedia).length;
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
  HTML_TAG_PATTERN.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const tagStart = match.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    appendText(html.slice(lastIndex, tagStart));

    const rawTag = match[0];
    const isClosing = match[1] === "</";
    const tagName = normalizeLowercaseStringOrEmpty(match[2]);
    const isSelfClosing =
      !isClosing &&
      (TELEGRAM_SELF_CLOSING_HTML_TAGS.has(tagName) || rawTag.trimEnd().endsWith("/>"));
    const isRichBlock = !isClosing && isTelegramRichBlockHtmlTag(rawTag, tagName);
    const isRichMedia =
      !isClosing &&
      (tagName === "figure" ||
        (TELEGRAM_RICH_MEDIA_HTML_TAGS.has(tagName) &&
          !openTags.some((tag) => tag.name === "figure")));

    if (!isClosing) {
      const nextCloseLength = isSelfClosing ? 0 : `</${tagName}>`.length;
      if (
        chunkHasPayload &&
        ((blockLimit !== undefined && isRichBlock && currentBlockCount >= blockLimit) ||
          (mediaLimit !== undefined && isRichMedia && currentMediaCount >= mediaLimit) ||
          current.length +
            rawTag.length +
            buildTelegramHtmlCloseSuffixLength(openTags) +
            nextCloseLength >
            normalizedLimit)
      ) {
        flushCurrent();
      }
    }

    const closesOpenTag = isClosing && openTags.some((tag) => tag.name === tagName);
    const closesSuppressedTag =
      isClosing && !closesOpenTag && popLastTagName(suppressedTagNames, tagName);
    if (!closesSuppressedTag) {
      current += rawTag;
    }
    if (isSelfClosing) {
      chunkHasPayload = true;
    }
    if (isRichBlock) {
      currentBlockCount += 1;
    }
    if (isRichMedia) {
      currentMediaCount += 1;
    }
    if (isClosing) {
      popTelegramHtmlTag(openTags, tagName);
    } else if (!isSelfClosing) {
      openTags.push({
        name: tagName,
        openTag: rawTag,
        closeTag: `</${tagName}>`,
        richBlock: isRichBlock,
        richMedia: isRichMedia,
      });
    }
    lastIndex = tagEnd;
  }

  appendText(html.slice(lastIndex));
  flushCurrent();
  return chunks.length > 0 ? chunks : [html];
}

function renderTelegramChunkHtml(ir: MarkdownIR): string {
  return wrapFileReferencesInHtml(preserveSupportedTelegramHtmlTags(renderTelegramHtml(ir)));
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
