import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
// Memory Core plugin module implements hybrid behavior.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyImportanceMultiplier } from "./importance.js";
import { applyMMRToHybridResults, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import { applyProjectRanking, projectScoreMultiplier } from "./project-ranking.js";
import {
  applyTemporalDecayToHybridResults,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

type HybridSource = string;
type ExactPathSpecificity = 0 | 1 | 2 | 3;

export type HybridSearchResult<TSource extends HybridSource = HybridSource> = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore: number;
  textScore: number;
  snippet: string;
  source: TSource;
  importance?: number;
  triggers?: string;
  projectKey?: string;
  provenance?: MemoryEntryProvenance;
};

type HybridVectorResult<TSource extends HybridSource = HybridSource> = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: TSource;
  snippet: string;
  vectorScore: number;
  importance?: number;
  triggers?: string;
  projectKey?: string;
  exactPathSpecificity?: ExactPathSpecificity;
  provenance?: MemoryEntryProvenance;
};

type HybridKeywordResult<TSource extends HybridSource = HybridSource> = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: TSource;
  snippet: string;
  textScore: number;
  hasBodyMatch?: boolean;
  importance?: number;
  triggers?: string;
  projectKey?: string;
  rankingScore?: number;
  pathScore?: number;
  exactPathSpecificity?: ExactPathSpecificity;
  provenance?: MemoryEntryProvenance;
};

export function buildFtsQuery(raw: string): string | null {
  const tokens = normalizeStringEntries(raw.match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

export function scoreExactPathTieForTemporalDecay(contentScore: number): number {
  return (1 + Math.max(0, Math.min(1, contentScore))) / 2;
}

export async function mergeHybridResults<TSource extends HybridSource>(params: {
  vector: HybridVectorResult<TSource>[];
  keyword: HybridKeywordResult<TSource>[];
  vectorWeight: number;
  textWeight: number;
  isNonTextMediaPath?: (path: string) => boolean;
  workspaceDir?: string;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<MMRConfig>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  activeProjectKeys?: readonly string[];
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
}): Promise<HybridSearchResult<TSource>[]> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: TSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
      rankingScore: number;
      pathScore: number;
      exactPathSpecificity: ExactPathSpecificity;
      hasBodyMatch: boolean;
      hasVector: boolean;
      hasKeyword: boolean;
      importance?: number;
      triggers?: string;
      projectKey?: string;
      provenance?: MemoryEntryProvenance;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
      rankingScore: 0,
      pathScore: 0,
      exactPathSpecificity: r.exactPathSpecificity ?? 0,
      hasBodyMatch: false,
      hasVector: true,
      hasKeyword: false,
      importance: r.importance,
      triggers: r.triggers,
      projectKey: r.projectKey,
      ...(r.provenance ? { provenance: r.provenance } : {}),
    });
  }

  for (const r of params.keyword) {
    const exactPathSpecificity = r.exactPathSpecificity ?? 0;
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      existing.hasBodyMatch = r.hasBodyMatch ?? r.textScore > 0;
      existing.rankingScore = r.rankingScore ?? r.textScore;
      existing.pathScore = r.pathScore ?? 0;
      existing.exactPathSpecificity = Math.max(
        existing.exactPathSpecificity,
        exactPathSpecificity,
      ) as ExactPathSpecificity;
      existing.hasKeyword = true;
      existing.importance ??= r.importance;
      existing.triggers ??= r.triggers;
      existing.projectKey ??= r.projectKey;
      if (!existing.provenance && r.provenance) {
        existing.provenance = r.provenance;
      }
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
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
        rankingScore: r.rankingScore ?? r.textScore,
        pathScore: r.pathScore ?? 0,
        exactPathSpecificity,
        hasBodyMatch: r.hasBodyMatch ?? r.textScore > 0,
        hasVector: false,
        hasKeyword: true,
        importance: r.importance,
        triggers: r.triggers,
        projectKey: r.projectKey,
        ...(r.provenance ? { provenance: r.provenance } : {}),
      });
    }
  }

  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const merged = Array.from(byId.values()).map((entry) => {
    // Exact specificity already carries path precedence. Keep body scores as
    // the within-tier signal, and use path BM25 only for partial path-only hits.
    const keywordScore =
      entry.textScore > 0
        ? entry.rankingScore
        : entry.exactPathSpecificity > 0
          ? 0
          : entry.pathScore;
    const dropMediaTextSignal =
      entry.hasVector &&
      !entry.hasKeyword &&
      params.vectorWeight > 0 &&
      params.isNonTextMediaPath?.(entry.path) === true;
    const contentScore = dropMediaTextSignal
      ? entry.vectorScore
      : params.vectorWeight * entry.vectorScore + params.textWeight * keywordScore;
    const hasWeightedContentRelevance = contentScore > 0;
    // LIKE recall has no weighted BM25 score. Its lexical score only breaks
    // ties between otherwise equal results.
    const lexicalRank = entry.hasBodyMatch && entry.textScore === 0 ? entry.rankingScore : 0;
    // With decay enabled, reserve the lower half of an exact tier for path
    // identity and the upper half for content relevance. This lets recency beat
    // a stale cap-selected content hit. Otherwise retain the established score.
    const weightedScore =
      entry.exactPathSpecificity > 0
        ? temporalDecayConfig.enabled
          ? scoreExactPathTieForTemporalDecay(contentScore)
          : hasWeightedContentRelevance
            ? contentScore
            : 1
        : contentScore;
    const result = {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: weightedScore,
      vectorScore: entry.vectorScore,
      textScore: entry.textScore,
      exactPathSpecificity: entry.exactPathSpecificity,
      hasWeightedContentRelevance,
      lexicalRank,
      snippet: entry.snippet,
      source: entry.source,
      importance: entry.importance,
      triggers: entry.triggers,
      projectKey: entry.projectKey,
    };
    if (entry.provenance) {
      Object.assign(result, { provenance: entry.provenance });
    }
    return result;
  });

  // Keep component scores as raw retrieval diagnostics. Temporal decay and MMR
  // may adjust the combined score, but cannot cross the exact-identifier tier.
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  const rankable = applyProjectRanking(
    applyImportanceMultiplier(decayed),
    params.activeProjectKeys,
  ).map((entry) => {
    // Specificity owns cross-tier precedence. Keep the decayed weighted score
    // separately for within-tier ranking while exact public scores stay at 1.
    const exactPathTieScore = entry.score;
    return Object.assign(entry, {
      exactPathTieScore,
      score:
        entry.exactPathSpecificity > 0
          ? projectScoreMultiplier(entry.projectKey, params.activeProjectKeys)
          : entry.score,
    });
  });
  const nonExact = rankable
    .filter((entry) => entry.exactPathSpecificity === 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        b.lexicalRank - a.lexicalRank ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine,
    );

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  const rerankExactGroup = (entries: typeof rankable) => {
    if (!mmrConfig.enabled) {
      return entries;
    }
    return applyMMRToHybridResults(
      entries.map((entry) => Object.assign(entry, { score: entry.exactPathTieScore })),
      mmrConfig,
    ).map((entry) =>
      Object.assign(entry, {
        score: projectScoreMultiplier(entry.projectKey, params.activeProjectKeys),
      }),
    );
  };
  const compareExactTieScores = (a: (typeof rankable)[number], b: (typeof rankable)[number]) =>
    b.exactPathTieScore - a.exactPathTieScore ||
    b.lexicalRank - a.lexicalRank ||
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine;
  const exact = ([3, 2, 1] as const).flatMap((specificity) => {
    const tier = rankable
      .filter((entry) => entry.exactPathSpecificity === specificity)
      .toSorted(compareExactTieScores);
    if (temporalDecayConfig.enabled) {
      return rerankExactGroup(tier);
    }
    const contentBacked = tier.filter(
      (entry) => entry.hasWeightedContentRelevance || entry.lexicalRank > 0,
    );
    const pathOnly = tier.filter(
      (entry) => !entry.hasWeightedContentRelevance && entry.lexicalRank === 0,
    );
    return rerankExactGroup(contentBacked).concat(rerankExactGroup(pathOnly));
  });
  const ranked = [
    ...exact,
    ...(mmrConfig.enabled ? applyMMRToHybridResults(nonExact, mmrConfig) : nonExact),
  ];

  return ranked.map(
    ({
      exactPathSpecificity: _exactPathSpecificity,
      exactPathTieScore: _exactPathTieScore,
      hasWeightedContentRelevance: _hasWeightedContentRelevance,
      lexicalRank: _lexicalRank,
      ...entry
    }) => entry,
  );
}

type HybridResultRange<TSource extends HybridSource = HybridSource> = Pick<
  HybridSearchResult<TSource>,
  "source" | "path" | "startLine" | "endLine"
>;

function hybridResultRangeKey(entry: HybridResultRange): string {
  return `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`;
}

export function selectHybridSearchResults<TSource extends HybridSource>(params: {
  merged: HybridSearchResult<TSource>[];
  keyword: HybridResultRange<TSource>[];
  maxResults: number;
  minScore: number;
}): HybridSearchResult<TSource>[] {
  const strict = params.merged.filter((entry) => entry.score >= params.minScore);
  const selected = strict.slice(0, params.maxResults);
  if (params.keyword.length === 0 || selected.length === params.maxResults) {
    return selected;
  }

  const keywordKeys = new Set(params.keyword.map((entry) => hybridResultRangeKey(entry)));
  if (strict.length === 0) {
    // Preserve the established all-lexical fallback when every weighted score
    // is below the configured threshold.
    return params.merged
      .filter((entry) => entry.score >= 0 && keywordKeys.has(hybridResultRangeKey(entry)))
      .slice(0, params.maxResults);
  }

  // Strict recall owns the result window. MMR-ranked keyword-only hits may use
  // spare capacity, but must never displace a qualifying result.
  const seen = new Set(selected.map((entry) => hybridResultRangeKey(entry)));
  for (const entry of params.merged) {
    if (selected.length === params.maxResults) {
      break;
    }
    const key = hybridResultRangeKey(entry);
    if (
      entry.score < params.minScore &&
      entry.vectorScore === 0 &&
      keywordKeys.has(key) &&
      !seen.has(key)
    ) {
      seen.add(key);
      selected.push(entry);
    }
  }
  return selected;
}
