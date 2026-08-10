// Model special token helpers strip model control tokens outside code regions.
import { findCodeRegions, isInsideCode } from "./code-regions.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

function overlapsCodeRegion(
  start: number,
  end: number,
  codeRegions: { start: number; end: number }[],
): boolean {
  return codeRegions.some((region) => start < region.end && end > region.start);
}

// A separator is only needed when removing the token would otherwise concatenate
// two runs of word content (letters/digits). Punctuation, whitespace, and markup
// delimiters already form a boundary; inserting a space there adds spurious
// whitespace and can break Markdown emphasis (e.g. `**bold **` stays literal
// instead of rendering as strong). Unicode-aware so non-Latin adjacent words
// (Cyrillic, CJK, etc.) still get separated.
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && WORD_CHAR_RE.test(value);
}

function shouldInsertSeparator(before: string | undefined, after: string | undefined): boolean {
  return isWordChar(before) && isWordChar(after);
}

/**
 * Strips leaked model control tokens like `<|assistant|>` or full-width pipe variants.
 * Code examples are preserved; remove this when providers stop emitting these tokens.
 *
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    out += text.slice(cursor, start);
    if (isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)) {
      out += matched;
    } else if (shouldInsertSeparator(text[start - 1], text[end])) {
      out += " ";
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
