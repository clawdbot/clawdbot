import { findCodeRegions } from "../../shared/text/code-regions.js";
import { flattenMarkdownDetails } from "./markdown-details.js";
// Plain-text sanitization strips internal runtime scaffolding and converts a
// conservative subset of model-produced HTML into channel-friendly text.
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";

// Retained for the deprecated plugin-sdk/infra-runtime compatibility barrel.
export { stripInternalRuntimeScaffolding };

// A tag name ends at whitespace, `/`, or `>`; `<user@example.com>` is prose, not markup.
const HTML_TAG_RE = /<\/?[a-z][a-z0-9_.:-]*(?=[\s/>])[^>]*>/gi;
const MAY_CONTAIN_MARKDOWN_CODE_RE = /[`~]|\t| {4}/;
const CODE_ESCAPE = "\u0000e";
const CODE_PLACEHOLDER = "\u0000p";

// Quoted attribute values may contain `>`; normalize convertible openers without leaking attribute text.
const CONVERTIBLE_HTML_OPEN_TAG_RE =
  /<(b|strong|i|em|s|strike|del|code|h[1-6]|li)(?=\s|>)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

function stripRemainingHtmlTags(text: string): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(HTML_TAG_RE, "");
  } while (current !== previous);
  return current;
}

function convertHtmlOutsideCode(text: string, options: { style?: "markdown" }): string {
  const boldMarker = options.style === "markdown" ? "**" : "*";
  const strikeMarker = options.style === "markdown" ? "~~" : "~";
  const converted = text
    // Preserve angle-bracket autolinks as plain URLs before tag stripping.
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1")
    // Normalize attributes once; conversions below only need exact bare tag names.
    .replace(CONVERTIBLE_HTML_OPEN_TAG_RE, "<$1>")
    // Line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Block elements → newlines
    .replace(/<\/?(p|div)>/gi, "\n")
    // Bold → selected lightweight markup
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, `${boldMarker}$2${boldMarker}`)
    // Italic → WhatsApp/Signal italic
    .replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_")
    // Strikethrough → selected lightweight markup
    .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, `${strikeMarker}$2${strikeMarker}`)
    // Inline code
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    // Headings → bold text with newline
    .replace(/<h[1-6]>(.*?)<\/h[1-6]>/gi, `\n${boldMarker}$1${boldMarker}\n`)
    // List items → bullet points
    .replace(/<li>(.*?)<\/li>/gi, "• $1\n");

  return stripRemainingHtmlTags(converted).replace(/\n{3,}/g, "\n\n");
}

/**
 * Convert common HTML tags to their plain-text/lightweight-markup equivalents
 * and strip anything that remains.
 *
 * The function is intentionally conservative — it only targets tags that models
 * are known to produce and avoids false positives on angle brackets in normal
 * prose (e.g. `a < b`), in fenced blocks, and in inline code spans.
 */
export function sanitizeForPlainText(text: string, options: { style?: "markdown" } = {}): string {
  const prepared = flattenMarkdownDetails(stripInternalRuntimeScaffolding(text));
  const conversionCanChangeCode = prepared.includes("<") || prepared.includes("\n\n\n");
  const codeRegions =
    conversionCanChangeCode && MAY_CONTAIN_MARKDOWN_CODE_RE.test(prepared)
      ? findCodeRegions(prepared)
      : [];
  if (codeRegions.length === 0) {
    return convertHtmlOutsideCode(prepared, options);
  }
  const preservedCode: string[] = [];
  let masked = "";
  let cursor = 0;
  for (const region of codeRegions) {
    masked += prepared.slice(cursor, region.start).replaceAll("\u0000", CODE_ESCAPE);
    masked += CODE_PLACEHOLDER;
    preservedCode.push(prepared.slice(region.start, region.end));
    cursor = region.end;
  }
  masked += prepared.slice(cursor).replaceAll("\u0000", CODE_ESCAPE);

  const converted = convertHtmlOutsideCode(masked, options);
  let restored = "";
  cursor = 0;
  for (const code of preservedCode) {
    const placeholder = converted.indexOf(CODE_PLACEHOLDER, cursor);
    if (placeholder === -1) {
      // The conversion stripped an HTML tag whose attribute region contained
      // this placeholder, so the in-place marker is gone. Skipping avoids
      // slicing with -1, which garbled and duplicated the remaining text.
      continue;
    }
    restored += converted.slice(cursor, placeholder).replaceAll(CODE_ESCAPE, "\u0000");
    restored += code;
    cursor = placeholder + CODE_PLACEHOLDER.length;
  }
  return restored + converted.slice(cursor).replaceAll(CODE_ESCAPE, "\u0000");
}
