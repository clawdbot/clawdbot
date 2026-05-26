import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Shared CJK-aware tokenizer + Jaccard similarity helpers.
 *
 * Originally introduced for memory MMR re-ranking; now also used by the dreaming
 * dedupe path so similar-but-not-identical CJK candidates do not slip past the
 * Jaccard threshold (issue #80613).
 */

/**
 * Regex matching CJK-family characters that lack whitespace word boundaries:
 * - CJK Unified Ideographs (Chinese hanzi, Japanese kanji, Korean hanja)
 * - CJK Extension A
 * - Hiragana & Katakana (Japanese)
 * - Hangul Syllables & Jamo (Korean)
 */
const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff]/;

/**
 * Tokenize text for Jaccard similarity computation.
 * Extracts alphanumeric tokens, CJK-family characters (unigrams),
 * and consecutive CJK character pairs (bigrams).
 *
 * Bigrams are only created from characters that are adjacent in the
 * original text, so mixed content like "我喜欢hello你好" will NOT
 * produce the spurious bigram "欢你".
 */
export function tokenize(text: string): Set<string> {
  const lower = normalizeLowercaseStringOrEmpty(text);
  const ascii = lower.match(/[a-z0-9_]+/g) ?? [];

  // Track CJK characters with their original positions
  const chars = Array.from(lower);
  const cjkData: { char: string; index: number }[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (CJK_RE.test(chars[i])) {
      cjkData.push({ char: chars[i], index: i });
    }
  }

  // Build bigrams only from originally adjacent CJK characters
  const bigrams: string[] = [];
  for (let i = 0; i < cjkData.length - 1; i++) {
    if (cjkData[i + 1].index === cjkData[i].index + 1) {
      bigrams.push(cjkData[i].char + cjkData[i + 1].char);
    }
  }

  const unigrams = cjkData.map((d) => d.char);
  return new Set([...ascii, ...bigrams, ...unigrams]);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns a value in [0, 1] where 1 means identical sets.
 */
export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Compute text similarity between two content strings using Jaccard on tokens.
 *
 * When BOTH inputs tokenize to empty sets (e.g. Cyrillic/Arabic/emoji-only or
 * punctuation-only snippets that contain no ASCII or CJK tokens), the raw
 * `jaccardSimilarity` returns `1` for two empty sets. To prevent the dreaming
 * dedupe path (and other callers that compare distinct strings via Jaccard)
 * from collapsing distinct non-tokenized snippets into one, we fall back to
 * exact normalized-string equality for that empty/empty case. Non-empty cases
 * continue to use Jaccard unchanged.
 */
export function textSimilarity(contentA: string, contentB: string): number {
  const tokensA = tokenize(contentA);
  const tokensB = tokenize(contentB);
  if (tokensA.size === 0 && tokensB.size === 0) {
    return normalizeLowercaseStringOrEmpty(contentA) ===
      normalizeLowercaseStringOrEmpty(contentB)
      ? 1
      : 0;
  }
  return jaccardSimilarity(tokensA, tokensB);
}
