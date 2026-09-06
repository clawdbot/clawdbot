import { findCodeRegions } from "../../shared/text/code-regions.js";
import { flattenMarkdownDetails } from "./markdown-details.js";
// Plain-text sanitization strips internal runtime scaffolding and converts a
// conservative subset of model-produced HTML into channel-friendly text.
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";

// Retained for the deprecated plugin-sdk/infra-runtime compatibility barrel.
export { stripInternalRuntimeScaffolding };

// A tag name ends at whitespace, `/`, or `>`; `<user@example.com>` is prose, not markup.
const HTML_TAG_RE = /<\/?[a-z][a-z0-9_.:-]*(?=[\s/>])[^>]*>/gi;
const LABELED_ANGLE_LINK_RE =
  /<(?:https?:\/\/|mailto:)[^<>\s|]+\|([^<>\r\n|]*[^<>\s|][^<>\r\n|]*)>/gi;
const MAY_CONTAIN_MARKDOWN_CODE_RE = /[`~]|\t| {4}/;
const CODE_ESCAPE = "\u0000e";
const CODE_PLACEHOLDER = "\u0000p";

// Quoted attribute values may contain `>`; normalize convertible openers without leaking attribute text.
const CONVERTIBLE_HTML_OPEN_TAG_RE =
  /<(b|strong|i|em|s|strike|del|code|h[1-6]|li|p|div)(?=\s|>)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
// br, p, and div own line structure, so they stay outside the inert-tree removal pass.
const EMPTY_HTML_ELEMENT_RE =
  /<((?!(?:br|p|div)(?=[\s>]))[a-z][a-z0-9_.:-]*)(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>(?:[^\S\r\n\u2028\u2029]|<(?!\/?(?:br|p|div)(?=[\s/>]))\/?[a-z][a-z0-9_.:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>)*<\/\1\s*>/gi;

function removeMatchesUntilStable(text: string, pattern: RegExp): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(pattern, "");
  } while (current !== previous);
  return current;
}

function convertHtmlOutsideCode(text: string, options: { style?: "markdown" }): string {
  const boldMarker = options.style === "markdown" ? "**" : "*";
  const strikeMarker = options.style === "markdown" ? "~~" : "~";
  // Remove inner elements first so an empty nested tree cannot synthesize markers.
  const converted = removeMatchesUntilStable(
    text
      // `|` ends the autolink URL so `<url|Label>` reaches the label projection.
      .replace(/<((?:https?:\/\/|mailto:)[^<>\s|]+)>/gi, "$1")
      // Raw channel link syntax is not an input dialect; retain only its visible label.
      .replace(LABELED_ANGLE_LINK_RE, "$1")
      // Normalize attributes once; conversions below only need exact bare tag names.
      .replace(CONVERTIBLE_HTML_OPEN_TAG_RE, "<$1>"),
    EMPTY_HTML_ELEMENT_RE,
  )
    .replace(/<br\s*\/?>/gi, "\n")
    // Block elements → newlines
    .replace(/<\/?(p|div)>/gi, "\n")
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, `${boldMarker}$2${boldMarker}`)
    .replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_")
    .replace(/<(s|strike|del)>(.*?)<\/\1>/gi, `${strikeMarker}$2${strikeMarker}`)
    .replace(/<code>(.*?)<\/code>/gi, "`$1`")
    .replace(/<h[1-6]>(.*?)<\/h[1-6]>/gi, `\n${boldMarker}$1${boldMarker}\n`)
    .replace(/<li>(.*?)<\/li>/gi, "• $1\n");

  return removeMatchesUntilStable(converted, HTML_TAG_RE).replace(/\n{3,}/g, "\n\n");
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
  const preservedText = new Map([[CODE_ESCAPE, "\u0000"]]);
  let masked = "";
  let cursor = 0;
  for (const region of codeRegions) {
    masked += prepared.slice(cursor, region.start).replaceAll("\u0000", CODE_ESCAPE);
    const placeholder = `${CODE_PLACEHOLDER}${preservedText.size};`;
    masked += placeholder;
    preservedText.set(placeholder, prepared.slice(region.start, region.end));
    cursor = region.end;
  }
  masked += prepared.slice(cursor).replaceAll("\u0000", CODE_ESCAPE);

  // HTML attributes can consume markers. Restore by identity in one pass so
  // surviving code keeps its position and literal marker-shaped text stays inert.
  return convertHtmlOutsideCode(masked, options).replace(
    // oxlint-disable-next-line eslint/no-control-regex -- Intentional NUL delimiters distinguish internal markers from escaped user text.
    /\u0000(?:e|p\d+;)/g,
    (marker) => preservedText.get(marker) ?? marker,
  );
}
