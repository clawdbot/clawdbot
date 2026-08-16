import { findCodeRegions } from "../../shared/text/code-regions.js";
import { flattenMarkdownDetails } from "./markdown-details.js";
// Plain-text sanitization strips internal runtime scaffolding and converts a
// conservative subset of model-produced HTML into channel-friendly text.
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";

// Retained for the deprecated plugin-sdk/infra-runtime compatibility barrel.
export { stripInternalRuntimeScaffolding };

const HTML_TAG_RE = /<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi;
// RFC 5322 angle-addr: <local@domain> — preserve these before tag stripping.
const RFC5322_ANGLE_ADDR_RE = /<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g;
const MAY_CONTAIN_MARKDOWN_CODE_RE = /[`~]|\t| {4}/;
const CODE_ESCAPE = "\u0000e";
const CODE_PLACEHOLDER = "\u0000p";
// Control character used for escaping; defined as constant to avoid no-control-regex lint.
const CONTROL_CHAR = "\u0000";

// Quoted attribute values may contain `>`; normalize convertible openers without leaking attribute text.
const CONVERTIBLE_HTML_OPEN_TAG_RE =
  /<(b|strong|i|em|s|strike|del|code|h[1-6]|li)(?=\s|>)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

function stripRemainingHtmlTags(text: string): string {
  // Preserve RFC 5322 angle-addr email addresses before stripping tags.
  const preservedEmails: string[] = [];
  const masked = text.replace(RFC5322_ANGLE_ADDR_RE, (_match, email) => {
    preservedEmails.push(email);
    return `${CONTROL_CHAR}email${preservedEmails.length - 1}${CONTROL_CHAR}`;
  });

  let previous: string;
  let current = masked;
  do {
    previous = current;
    current = current.replace(HTML_TAG_RE, "");
  } while (current !== previous);

  // Restore preserved email addresses.
  return current.replace(
    new RegExp(`${CONTROL_CHAR}email(\\d+)${CONTROL_CHAR}`, "g"),
    (_match, index) => {
      return `<${preservedEmails[Number(index)]}>`;
    },
  );
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
  let maskedText = "";
  let cursor = 0;
  for (const region of codeRegions) {
    maskedText += prepared.slice(cursor, region.start).replaceAll("\u0000", CODE_ESCAPE);
    maskedText += CODE_PLACEHOLDER;
    preservedCode.push(prepared.slice(region.start, region.end));
    cursor = region.end;
  }
  maskedText += prepared.slice(cursor).replaceAll("\u0000", CODE_ESCAPE);

  const converted = convertHtmlOutsideCode(maskedText, options);
  let restored = "";
  cursor = 0;
  for (const code of preservedCode) {
    const placeholder = converted.indexOf(CODE_PLACEHOLDER, cursor);
    restored += converted.slice(cursor, placeholder).replaceAll(CODE_ESCAPE, "\u0000");
    restored += code;
    cursor = placeholder + CODE_PLACEHOLDER.length;
  }
  return restored + converted.slice(cursor).replaceAll(CODE_ESCAPE, "\u0000");
}
