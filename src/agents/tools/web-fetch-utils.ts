/**
 * web_fetch extraction utilities.
 *
 * Converts lightweight HTML into bounded markdown/text without pulling in a full renderer.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { decodeHtmlEntityAt } from "../utils/html.js";
import { sanitizeHtml, stripInvisibleUnicode } from "./web-fetch-visibility.js";

/** Output mode requested by web_fetch extraction. */
export type ExtractMode = "markdown" | "text";

const HTML_TAG_RE = /<[^>]+>/g;
const SCRIPT_TAG_BLOCK_RE = /<script[\s\S]*?<\/script>/gi;
const STYLE_TAG_BLOCK_RE = /<style[\s\S]*?<\/style>/gi;
const NOSCRIPT_TAG_BLOCK_RE = /<noscript[\s\S]*?<\/noscript>/gi;
const SCRIPT_STYLE_NOSCRIPT_OPEN_RE = /<(?:script|style|noscript)\b/i;
const ANCHOR_OPEN_RE = /<a\s/i;
const ANCHOR_RE = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const HEADING_OPEN_RE = /<h[1-6]\b/i;
const HEADING_RE = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
const LIST_ITEM_OPEN_RE = /<li\b/i;
const LIST_ITEM_RE = /<li[^>]*>([\s\S]*?)<\/li>/gi;
const BLOCK_BREAK_RE =
  /<(?:br|hr)\s*\/?>|<\/(?:p|div|section|article|header|footer|table|tr|ul|ol)>/gi;

// Decode entities through the canonical shared decoder (agents/utils/html.ts) so web_fetch and the
// renderer share one entity contract — the divergent hand-rolled copy here was what truncated astral
// entities. A single left-to-right pass also avoids double-decoding "&amp;#39;" into "'", because the
// "&amp;" is consumed before its following "#39;" is ever seen as an entity.
function decodeEntities(value: string): string {
  if (!value.includes("&")) {
    return value;
  }
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "&") {
      // &nbsp; is not an escapable entity in the shared decoder; render it as a space.
      if (value.slice(i, i + 6).toLowerCase() === "&nbsp;") {
        out += " ";
        i += 5;
        continue;
      }
      const decoded = decodeHtmlEntityAt(value, i);
      if (decoded) {
        out += decoded.text;
        i += decoded.length - 1;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

function stripTags(value: string): string {
  const withoutTags = value.includes("<") ? value.replace(HTML_TAG_RE, "") : value;
  return decodeEntities(withoutTags);
}

/** Collapses display whitespace while preserving paragraph breaks. */
export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Converts sanitized HTML into coarse markdown plus an optional title. */
export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;
  let text = html;
  if (SCRIPT_STYLE_NOSCRIPT_OPEN_RE.test(text)) {
    text = text
      .replace(SCRIPT_TAG_BLOCK_RE, "")
      .replace(STYLE_TAG_BLOCK_RE, "")
      .replace(NOSCRIPT_TAG_BLOCK_RE, "");
  }
  if (ANCHOR_OPEN_RE.test(text)) {
    text = text.replace(ANCHOR_RE, (_, href, body) => {
      const label = normalizeWhitespace(stripTags(body));
      if (!label) {
        return href;
      }
      // Preserve link targets in markdown mode so fetched pages remain source-auditable.
      return `[${label}](${href})`;
    });
  }
  if (HEADING_OPEN_RE.test(text)) {
    text = text.replace(HEADING_RE, (_, level, body) => {
      const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
      const label = normalizeWhitespace(stripTags(body));
      return `\n${prefix} ${label}\n`;
    });
  }
  if (LIST_ITEM_OPEN_RE.test(text)) {
    text = text.replace(LIST_ITEM_RE, (_, body) => {
      const label = normalizeWhitespace(stripTags(body));
      return label ? `\n- ${label}` : "";
    });
  }
  text = text.replace(BLOCK_BREAK_RE, "\n");
  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

/** Removes markdown decoration for plain text extraction. */
export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

/** Truncates text by characters and reports whether truncation occurred. */
export function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: truncateUtf16Safe(value, maxChars), truncated: true };
}

/** Sanitizes HTML and extracts either markdown or plain text content. */
export async function extractBasicHtmlContent(params: {
  html: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = await sanitizeHtml(params.html);
  const rendered = htmlToMarkdown(cleanHtml);
  if (params.extractMode === "text") {
    const text =
      stripInvisibleUnicode(markdownToText(rendered.text)) ||
      stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)));
    return text ? { text, title: rendered.title } : null;
  }
  const text = stripInvisibleUnicode(rendered.text);
  return text ? { text, title: rendered.title } : null;
}
