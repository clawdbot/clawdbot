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
// two runs of word content (letters/digits/marks). Punctuation, whitespace, and
// markup delimiters already form a boundary; inserting a space there adds spurious
// whitespace and can break Markdown emphasis (e.g. `**bold **` stays literal
// instead of rendering as strong). Unicode-aware so non-Latin adjacent content
// (Cyrillic, CJK, astral letters, combining marks) still gets separated.
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

// Tests whether the code point adjacent to the token boundary is word content.
// Reads the complete code point so a supplementary-plane surrogate pair (e.g.
// 𐐀, U+10400) is matched as one character — passing a lone surrogate half to
// WORD_CHAR_RE never matches, which would wrongly merge adjacent astral letters.
// `\p{M}` covers combining marks so a word ending in a decomposed mark (café)
// is still treated as word content at the boundary.
function isWordCharAt(text: string, index: number, before: boolean): boolean {
  let i = before ? index - 1 : index;
  if (i < 0 || i >= text.length) {
    return false;
  }
  // Looking backward, back up one unit when index-1 is the low half of a pair.
  const backsOverPair =
    before &&
    i > 0 &&
    isLowSurrogate(text.charCodeAt(i)) &&
    isHighSurrogate(text.charCodeAt(i - 1));
  if (backsOverPair) {
    i -= 1;
  }
  // codePointAt returns the full code point for a high+low surrogate pair, so a
  // value above the BMP marks a two-unit character to slice.
  const codePoint = text.codePointAt(i) ?? text.charCodeAt(i);
  return WORD_CHAR_RE.test(text.slice(i, i + (codePoint > 0xffff ? 2 : 1)));
}

function shouldInsertSeparator(text: string, start: number, end: number): boolean {
  return isWordCharAt(text, start, true) && isWordCharAt(text, end, false);
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
    } else if (shouldInsertSeparator(text, start, end)) {
      out += " ";
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
