import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Maximal Marginal Relevance (MMR) re-ranking algorithm.
 *
 * MMR balances relevance with diversity by iteratively selecting results
 * that maximize: λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * @see Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking" (1998)
 */

export type MMRItem = {
  id: string;
  score: number;
  content: string;
};

export type MMRConfig = {
  /** Enable/disable MMR re-ranking. Default: false (opt-in) */
  enabled: boolean;
  /** Lambda parameter: 0 = max diversity, 1 = max relevance. Default: 0.7 */
  lambda: number;
};

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

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
 */
export function textSimilarity(contentA: string, contentB: string): number {
  return jaccardSimilarity(tokenize(contentA), tokenize(contentB));
}

/**
 * Compute the maximum similarity between an item and all selected items.
 */
function maxSimilarityToSelected(
  item: MMRItem,
  selectedItems: MMRItem[],
  tokenCache: Map<string, Set<string>>,
): number {
  if (selectedItems.length === 0) {
    return 0;
  }

  let maxSim = 0;
  const itemTokens = tokenCache.get(item.id) ?? tokenize(item.content);

  for (const selected of selectedItems) {
    const selectedTokens = tokenCache.get(selected.id) ?? tokenize(selected.content);
    const sim = jaccardSimilarity(itemTokens, selectedTokens);
    if (sim > maxSim) {
      maxSim = sim;
    }
  }

  return maxSim;
}

/**
 * Compute MMR score for a candidate item.
 * MMR = λ * relevance - (1-λ) * max_similarity_to_selected
 */
export function computeMMRScore(relevance: number, maxSimilarity: number, lambda: number): number {
  return lambda * relevance - (1 - lambda) * maxSimilarity;
}

/**
 * Re-rank items using Maximal Marginal Relevance (MMR).
 *
 * The algorithm iteratively selects items that balance relevance with diversity:
 * 1. Start with the highest-scoring item
 * 2. For each remaining slot, select the item that maximizes the MMR score
 * 3. MMR score = λ * relevance - (1-λ) * max_similarity_to_already_selected
 *
 * @param items - Items to re-rank, must have score and content
 * @param config - MMR configuration (lambda, enabled)
 * @returns Re-ranked items in MMR order
 */
export function mmrRerank<T extends MMRItem>(items: T[], config: Partial<MMRConfig> = {}): T[] {
  const { enabled = DEFAULT_MMR_CONFIG.enabled, lambda = DEFAULT_MMR_CONFIG.lambda } = config;

  // Early exits
  if (!enabled || items.length <= 1) {
    return [...items];
  }

  // Clamp lambda to valid range
  const clampedLambda = Math.max(0, Math.min(1, lambda));

  // If lambda is 1, just return sorted by relevance (no diversity penalty)
  if (clampedLambda === 1) {
    return [...items].toSorted((a, b) => b.score - a.score);
  }

  // Pre-tokenize all items for efficiency
  const tokenCache = new Map<string, Set<string>>();
  for (const item of items) {
    tokenCache.set(item.id, tokenize(item.content));
  }

  // Normalize scores to [0, 1] for fair comparison with similarity
  const maxScore = Math.max(...items.map((i) => i.score));
  const minScore = Math.min(...items.map((i) => i.score));
  const scoreRange = maxScore - minScore;

  const normalizeScore = (score: number): number => {
    if (scoreRange === 0) {
      return 1; // All scores equal
    }
    return (score - minScore) / scoreRange;
  };

  const selected: T[] = [];
  const remaining = new Set(items);

  // Select items iteratively
  while (remaining.size > 0) {
    let bestItem: T | null = null;
    let bestMMRScore = -Infinity;

    for (const candidate of remaining) {
      const normalizedRelevance = normalizeScore(candidate.score);
      const maxSim = maxSimilarityToSelected(candidate, selected, tokenCache);
      const mmrScore = computeMMRScore(normalizedRelevance, maxSim, clampedLambda);

      // Use original score as tiebreaker (higher is better)
      if (
        mmrScore > bestMMRScore ||
        (mmrScore === bestMMRScore && candidate.score > (bestItem?.score ?? -Infinity))
      ) {
        bestMMRScore = mmrScore;
        bestItem = candidate;
      }
    }

    if (bestItem) {
      selected.push(bestItem);
      remaining.delete(bestItem);
    } else {
      // Should never happen, but safety exit
      break;
    }
  }

  return selected;
}

/**
 * Apply MMR re-ranking to hybrid search results.
 * Adapts the generic MMR function to work with the hybrid search result format.
 */
export function applyMMRToHybridResults<
  T extends { score: number; snippet: string; path: string; startLine: number },
>(results: T[], config: Partial<MMRConfig> = {}): T[] {
  if (results.length === 0) {
    return results;
  }

  // Create a map from ID to original item for type-safe retrieval
  const itemById = new Map<string, T>();

  // Create MMR items with unique IDs
  const mmrItems: MMRItem[] = results.map((r, index) => {
    const id = `${r.path}:${r.startLine}:${index}`;
    itemById.set(id, r);
    return {
      id,
      score: r.score,
      content: r.snippet,
    };
  });

  const reranked = mmrRerank(mmrItems, config);

  // Map back to original items using the ID
  return reranked.map((item) => itemById.get(item.id)!);
}
