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
// two runs of word content (letters/digits). Punctuation, whitespace, and
// markup delimiters already form a boundary; inserting a space there adds
// spurious whitespace and can break Markdown emphasis (e.g. `**bold **` stays
// literal instead of rendering as strong). Unicode-aware so non-Latin adjacent
// content (Cyrillic, CJK, astral letters) still gets separated.
const LEFT_WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;
// The right boundary excludes combining marks: a mark immediately after a
// removed token attaches to the base before the token (across the gap once the
// token is gone), not to the word after it, so it does not start a right-side
// word. Treating it as word content would insert a space that splits a
// decomposed grapheme (cafe<|token|>́word -> "cafe ́word").
const RIGHT_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

// Tests whether the code point adjacent to a token-run boundary is word content.
// Reads the complete code point so a supplementary-plane surrogate pair (e.g.
// U+10400) is matched as one character. The left side counts a combining mark
// as word content (it belongs to the preceding base); the right side does not,
// because a mark there attaches across the removed token to the left base.
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
  const slice = text.slice(i, i + (codePoint > 0xffff ? 2 : 1));
  return (before ? LEFT_WORD_CHAR_RE : RIGHT_WORD_CHAR_RE).test(slice);
}

function shouldInsertSeparator(text: string, start: number, end: number): boolean {
  return isWordCharAt(text, start, true) && isWordCharAt(text, end, false);
}

function isRemovableToken(
  token: { start: number; end: number },
  codeRegions: { start: number; end: number }[],
): boolean {
  return (
    !isInsideCode(token.start, codeRegions) &&
    !overlapsCodeRegion(token.start, token.end, codeRegions)
  );
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
  const tokens = [...text.matchAll(MODEL_SPECIAL_TOKEN_RE)].map((m) => {
    const start = m.index ?? 0;
    return { matched: m[0], start, end: start + m[0].length };
  });
  if (tokens.length === 0) {
    return text;
  }
  const codeRegions = findCodeRegions(text);

  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    const { matched, start, end } = token;
    out += text.slice(cursor, start);
    if (!isRemovableToken(token, codeRegions)) {
      out += matched;
      cursor = end;
      i++;
      continue;
    }
    // Coalesce contiguous removable tokens into one removal run so the separator
    // decision sees the surviving characters on either side, not the intermediate
    // token delimiters (a<|x|><|y|>b would otherwise see `<`/`>` at the inner
    // boundaries and merge the two words).
    let runEnd = end;
    let next = tokens[i + 1];
    while (next && next.start === runEnd && isRemovableToken(next, codeRegions)) {
      runEnd = next.end;
      i++;
      next = tokens[i + 1];
    }
    if (shouldInsertSeparator(text, start, runEnd)) {
      out += " ";
    }
    cursor = runEnd;
    i++;
  }
  out += text.slice(cursor);
  return out;
}
