import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import {
  FILE_REF_EXTENSIONS_WITH_TLD,
  isAutoLinkedFileRef,
  markdownToIR,
  normalizeLowercaseStringOrEmpty,
  type MarkdownLinkSpan,
  type MarkdownIR,
  renderMarkdownIRChunksWithinLimit,
} from "openclaw/plugin-sdk/text-runtime";
import { renderMarkdownWithMarkers } from "openclaw/plugin-sdk/text-runtime";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
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

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
      spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
      blockquote: { open: "<blockquote>", close: "</blockquote>" },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

export function markdownToTelegramHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; wrapFileRefs?: boolean } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const html = renderTelegramHtml(ir);
  // Apply file reference wrapping if requested (for chunked rendering)
  if (options.wrapFileRefs !== false) {
    return wrapFileReferencesInHtml(html);
  }
  return html;
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
let fileReferencePattern: RegExp | undefined;
let orphanedTldPattern: RegExp | undefined;

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
    // For HTML mode, trust caller markup - don't modify
    return text;
  }
  // markdownToTelegramHtml already wraps file references by default
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

type TelegramHtmlTag = {
  name: string;
  openTag: string;
  closeTag: string;
};

const TELEGRAM_SELF_CLOSING_HTML_TAGS = new Set(["br"]);

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

function findTelegramHtmlSafeSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return text.length;
  }
  const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
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

export function splitTelegramHtmlChunks(html: string, limit: number): string[] {
  if (!html) {
    return [];
  }
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (html.length <= normalizedLimit) {
    return [html];
  }

  const chunks: string[] = [];
  const openTags: TelegramHtmlTag[] = [];
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
          throw new Error(
            `Telegram HTML chunk limit exceeded by tag overhead (limit=${normalizedLimit})`,
          );
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

    current += rawTag;
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

function renderTelegramChunkHtml(ir: MarkdownIR): string {
  return wrapFileReferencesInHtml(renderTelegramHtml(ir));
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
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  return renderTelegramChunksWithinHtmlLimit(ir, limit);
}

export function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[] {
  return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}
