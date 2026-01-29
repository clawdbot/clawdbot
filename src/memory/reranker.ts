/**
 * Reranker module for memory search results.
 *
 * Provides lightweight, non-LLM reranking strategies to combine
 * and reorder results from multiple retrieval sources.
 */

export type RerankerInput = {
  id: string;
  vectorRank?: number;
  keywordRank?: number;
  snippet?: string;
};

export type RerankerOutput = {
  id: string;
  rank: number;
  rrfScore?: number;
};

export type RerankerMethod = "rrf" | "none";

export type RerankerOptions = {
  method: RerankerMethod;
  rrf?: {
    k?: number; // smoothing constant (default: 60)
  };
};

const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Combines rankings from multiple sources using the formula:
 *   score = sum(1 / (k + rank_i)) for each source
 *
 * Benefits:
 * - No need to normalize incompatible scores
 * - Proven effective in hybrid search (Elasticsearch, Vespa)
 * - Deterministic and fast
 *
 * @param k - Smoothing constant (default 60). Higher = less weight to top ranks.
 */
export function rerankRRF(inputs: RerankerInput[], k: number = DEFAULT_RRF_K): RerankerOutput[] {
  if (inputs.length === 0) return [];

  const scored = inputs.map((input) => {
    let rrfScore = 0;
    if (input.vectorRank !== undefined && input.vectorRank > 0) {
      rrfScore += 1 / (k + input.vectorRank);
    }
    if (input.keywordRank !== undefined && input.keywordRank > 0) {
      rrfScore += 1 / (k + input.keywordRank);
    }
    return { id: input.id, rrfScore };
  });

  scored.sort((a, b) => b.rrfScore - a.rrfScore);

  return scored.map((item, index) => ({
    id: item.id,
    rank: index + 1,
    rrfScore: item.rrfScore,
  }));
}

/**
 * Main reranker entry point.
 *
 * @param inputs - Results with rank info from each source
 * @param options - Reranking configuration
 * @returns Reranked results with final rank assignment
 */
export function rerank(inputs: RerankerInput[], options: RerankerOptions): RerankerOutput[] {
  if (options.method === "none" || inputs.length === 0) {
    return inputs.map((input, index) => ({ id: input.id, rank: index + 1 }));
  }

  if (options.method === "rrf") {
    const k = options.rrf?.k ?? DEFAULT_RRF_K;
    return rerankRRF(inputs, k);
  }

  return inputs.map((input, index) => ({ id: input.id, rank: index + 1 }));
}
