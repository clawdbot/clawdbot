// Model special token helpers strip model control tokens outside code regions.
import { findCodeRegions } from "./code-regions.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

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
    if (codeRegions.some((region) => start < region.end && end > region.start)) {
      out += matched;
    } else if (
      // Retained text handles adjacent tokens; two code units preserve astral letters.
      // A following combining mark stays attached, and punctuation needs no separator.
      /[\p{L}\p{M}\p{N}]$/u.test(out.slice(-2)) &&
      /^[\p{L}\p{N}]/u.test(text.slice(end, end + 2))
    ) {
      out += " ";
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
