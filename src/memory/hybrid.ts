import { rerank, type RerankerInput } from "./reranker.js";

export type HybridSource = string;

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

export type RerankerMethod = "rrf" | "weighted" | "none";

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export type MergeHybridParams = {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  reranker?: {
    method: RerankerMethod;
    rrf?: { k: number };
  };
};

export type MergedResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
};

export function mergeHybridResults(params: MergeHybridParams): MergedResult[] {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
      vectorRank?: number;
      keywordRank?: number;
    }
  >();

  for (let i = 0; i < params.vector.length; i++) {
    const r = params.vector[i];
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
      vectorRank: i + 1,
    });
  }

  for (let i = 0; i < params.keyword.length; i++) {
    const r = params.keyword[i];
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      existing.keywordRank = i + 1;
      if (r.snippet && r.snippet.length > 0) existing.snippet = r.snippet;
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
        keywordRank: i + 1,
      });
    }
  }

  const entries = Array.from(byId.values());
  const method = params.reranker?.method ?? "weighted";

  if (method === "rrf") {
    const rerankerInputs: RerankerInput[] = entries.map((e) => ({
      id: e.id,
      vectorRank: e.vectorRank,
      keywordRank: e.keywordRank,
    }));
    const reranked = rerank(rerankerInputs, {
      method: "rrf",
      rrf: { k: params.reranker?.rrf?.k ?? 60 },
    });

    const idToRank = new Map(reranked.map((r) => [r.id, r]));
    return entries
      .map((entry) => {
        const ranked = idToRank.get(entry.id);
        return {
          id: entry.id,
          path: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          score: ranked?.rrfScore ?? 0,
          snippet: entry.snippet,
          source: entry.source,
          rank: ranked?.rank ?? entries.length,
        };
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ rank: _, ...rest }) => rest);
  }

  if (method === "none") {
    return entries.map((entry) => ({
      id: entry.id,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: entry.vectorScore || entry.textScore,
      snippet: entry.snippet,
      source: entry.source,
    }));
  }

  const merged = entries.map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      id: entry.id,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  return merged.sort((a, b) => b.score - a.score);
}
