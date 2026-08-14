// Memory Core plugin module owns keyword retrieval and ranking.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  readCuratedProjectMemoryCandidates,
  readCuratedMemoryTriggerCandidates,
  readMemoryRecallMetadata,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  type MemorySearchResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { bm25RankToScore, buildFtsQuery, scoreExactPathTieForTemporalDecay } from "./hybrid.js";
import { applyImportanceMultiplier } from "./importance.js";
import { MemoryProviderLifecycle } from "./manager-provider-lifecycle.js";
import {
  resolveExactPathSpecificity,
  searchKeyword,
  searchPathKeyword,
  type ExactPathSpecificity,
} from "./manager-search.js";
import { applyProjectRanking } from "./project-ranking.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const SNIPPET_MAX_CHARS = 700;
const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const PATH_FTS_TABLE = MEMORY_INDEX_PATHS_FTS_TABLE;
const KEYWORD_FALLBACK_SEARCH_TERM_LIMIT = 6;
const EXACT_PATH_CANDIDATE_LIMIT = 200;
const log = createSubsystemLogger("memory");

export type KeywordSearchHit = MemorySearchResult & {
  id: string;
  textScore: number;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
};

function compareKeywordSearchHits(
  a: KeywordSearchHit,
  b: KeywordSearchHit,
  preferExactBody = true,
): number {
  const specificityDelta = b.exactPathSpecificity - a.exactPathSpecificity;
  if (specificityDelta !== 0) {
    return specificityDelta;
  }
  if (preferExactBody && a.exactPathSpecificity > 0) {
    const bodyPresenceDelta = Number(b.textScore > 0) - Number(a.textScore > 0);
    if (bodyPresenceDelta !== 0) {
      return bodyPresenceDelta;
    }
  }
  // Score carries body relevance plus any configured decay. Exact tiers ignore
  // path BM25 because specificity already owns path precedence.
  const relevanceDelta = b.score - a.score;
  if (relevanceDelta !== 0) {
    return relevanceDelta;
  }
  const textDelta = b.textScore - a.textScore;
  if (textDelta !== 0) {
    return textDelta;
  }
  if (a.exactPathSpecificity === 0) {
    const pathDelta = b.pathScore - a.pathScore;
    if (pathDelta !== 0) {
      return pathDelta;
    }
  }
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id);
}

export abstract class MemoryKeywordRetrieval extends MemoryProviderLifecycle {
  private selectScoredResults<T extends MemorySearchResult & { score: number }>(
    results: T[],
    maxResults: number,
    minScore: number,
    relaxedMinScore = minScore,
  ): T[] {
    const strict = results.filter((entry) => entry.score >= minScore);
    if (strict.length > 0) {
      return strict.slice(0, maxResults);
    }
    return results.filter((entry) => entry.score >= relaxedMinScore).slice(0, maxResults);
  }

  async listTriggerCandidates(opts?: {
    limit?: number;
    activeProjectKeys?: string[];
  }): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(512, Math.floor(opts?.limit ?? 512)));
    return this.toCuratedMemorySearchResults(
      readCuratedMemoryTriggerCandidates(this.db, limit, opts?.activeProjectKeys),
    );
  }

  async listCuratedProjectCandidates(opts: {
    activeProjectKeys: string[];
    limit?: number;
  }): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(512, Math.floor(opts.limit ?? 48)));
    return this.toCuratedMemorySearchResults(
      readCuratedProjectMemoryCandidates(this.db, limit, opts.activeProjectKeys),
    );
  }

  private toCuratedMemorySearchResults(
    rows: ReturnType<typeof readCuratedMemoryTriggerCandidates>,
  ): MemorySearchResult[] {
    return rows.map((row) => {
      const result: MemorySearchResult = {
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 0,
        snippet: row.text,
        source: "memory",
      };
      if (typeof row.importance === "number") {
        result.importance = row.importance;
      }
      if (typeof row.triggers === "string" && row.triggers.trim()) {
        result.triggers = row.triggers.trim();
      }
      if (typeof row.project_key === "string" && row.project_key.trim()) {
        result.projectKey = row.project_key.trim();
      }
      return result;
    });
  }

  private rankKeywordOnlyResults(
    results: KeywordSearchHit[],
    preferExactBody = true,
  ): KeywordSearchHit[] {
    return results
      .toSorted((left, right) => compareKeywordSearchHits(left, right, preferExactBody))
      .map((entry) =>
        entry.exactPathSpecificity > 0 ? Object.assign(entry, { score: 1 }) : entry,
      );
  }

  protected async finalizeKeywordOnlyResults(params: {
    results: KeywordSearchHit[];
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
    maxResults: number;
    minScore: number;
    activeProjectKeys?: readonly string[];
  }): Promise<MemorySearchResult[]> {
    const appliesTemporalDecay = params.temporalDecay?.enabled === true;
    const decayInputs = appliesTemporalDecay
      ? params.results.map((entry) => {
          if (entry.exactPathSpecificity === 0) {
            return entry;
          }
          const contentScore = entry.textScore > 0 ? entry.score : 0;
          return { ...entry, score: scoreExactPathTieForTemporalDecay(contentScore) };
        })
      : params.results;
    const decayed = await applyTemporalDecayToHybridResults({
      results: decayInputs,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    });
    const ranked = applyProjectRanking(
      this.rankKeywordOnlyResults(applyImportanceMultiplier(decayed), !appliesTemporalDecay),
      params.activeProjectKeys,
    );
    return this.toMemorySearchResults(
      this.selectScoredResults(ranked, params.maxResults, params.minScore, 0),
    );
  }

  protected attachRecallMetadata<T extends MemorySearchResult & { id: string }>(results: T[]): T[] {
    if (results.length === 0) {
      return results;
    }
    const metadataById = readMemoryRecallMetadata(
      this.db,
      results.map((entry) => entry.id),
    );
    return results.map((entry) => {
      const row = metadataById.get(entry.id);
      return {
        ...entry,
        ...(typeof row?.importance === "number" ? { importance: row.importance } : {}),
        ...(typeof row?.triggers === "string" && row.triggers.trim()
          ? { triggers: row.triggers.trim() }
          : {}),
        ...(typeof row?.project_key === "string" && row.project_key.trim()
          ? { projectKey: row.project_key.trim() }
          : {}),
      };
    });
  }

  private async searchKeyword(
    query: string,
    limit: number,
    options?: {
      boostFallbackRanking?: boolean;
      exactPathQuery?: string;
      rankingQuery?: string;
    },
    sourceFilterList?: MemorySource[],
  ): Promise<KeywordSearchHit[]> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const bodySearch = searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      query,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter: this.buildSourceFilter(undefined, sourceFilterList),
      buildFtsQuery,
      bm25RankToScore,
      boostFallbackRanking: options?.boostFallbackRanking,
      rankingQuery: options?.rankingQuery,
    }).catch((err: unknown) => {
      log.warn(`memory search: body keyword query failed: ${formatErrorMessage(err)}`);
      return [];
    });
    const exactPathQuery = options?.exactPathQuery ?? query;
    const pathSearch = searchPathKeyword({
      db: this.db,
      pathFtsTable: PATH_FTS_TABLE,
      query,
      exactPathQuery,
      exactPathLimit: EXACT_PATH_CANDIDATE_LIMIT,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter: this.buildSourceFilter(PATH_FTS_TABLE, sourceFilterList),
      buildFtsQuery,
      bm25RankToScore,
    }).catch((err: unknown) => {
      log.warn(`memory search: path keyword query failed: ${formatErrorMessage(err)}`);
      return [];
    });
    const [bodyResults, pathResults] = await Promise.all([bodySearch, pathSearch]);
    const merged = this.mergeKeywordSearchHits(
      [
        bodyResults.map((entry) =>
          Object.assign(entry, {
            exactPathSpecificity: resolveExactPathSpecificity(exactPathQuery, entry.path),
            pathScore: 0,
          }),
        ),
        pathResults,
      ],
      exactPathQuery,
    );
    return this.attachRecallMetadata(this.limitKeywordSearchHits(merged, limit));
  }

  protected async searchKeywordWithFallback(
    query: string,
    limit: number,
    options: { boostFallbackRanking?: boolean } | undefined,
    sourceFilterList: MemorySource[],
  ): Promise<KeywordSearchHit[]> {
    const fullQueryResults = await this.searchKeyword(
      query,
      limit,
      options,
      sourceFilterList,
    ).catch(() => []);
    const nonExactResults = fullQueryResults.filter((result) => result.exactPathSpecificity === 0);
    if (nonExactResults.length >= limit) {
      return fullQueryResults;
    }

    // Supplement thin candidate pools for conversational queries, but cap the
    // extra FTS probes so long prompts cannot fan out into unbounded sqlite work.
    const fallbackTerms = this.resolveKeywordFallbackTerms(query);
    if (fallbackTerms.length === 0) {
      return fullQueryResults;
    }
    const strictFtsQuery = buildFtsQuery(query)?.toLowerCase();
    const keywordFtsQuery = buildFtsQuery(fallbackTerms.join(" "))?.toLowerCase();
    if (fullQueryResults.length > 0 && strictFtsQuery === keywordFtsQuery) {
      // Expansion did not normalize this already-matching keyword query; OR
      // probes can only weaken its strict relevance before importance ranking.
      return fullQueryResults;
    }

    const resultSets = await Promise.all(
      fallbackTerms.map((term) =>
        this.searchKeyword(
          term,
          limit,
          { ...options, exactPathQuery: query, rankingQuery: query },
          sourceFilterList,
        ).catch(() => []),
      ),
    );
    return this.limitKeywordSearchHits(
      this.mergeKeywordSearchHits([fullQueryResults, ...resultSets], query),
      limit,
    );
  }

  private resolveKeywordFallbackTerms(query: string): string[] {
    const normalizedQuery = query.trim().toLowerCase();
    const keywords = extractKeywords(query, {
      ftsTokenizer: this.settings.store.fts.tokenizer,
    }).filter((term) => term !== normalizedQuery);
    return keywords.slice(0, KEYWORD_FALLBACK_SEARCH_TERM_LIMIT);
  }

  private mergeKeywordSearchHits(
    resultSets: KeywordSearchHit[][],
    exactPathQuery?: string,
  ): KeywordSearchHit[] {
    const seenIds = new Map<string, KeywordSearchHit>();
    for (const results of resultSets) {
      for (const result of results) {
        const existing = seenIds.get(result.id);
        if (!existing) {
          seenIds.set(result.id, result);
          continue;
        }
        const existingHasBody = existing.textScore > 0;
        const resultHasBody = result.textScore > 0;
        const existingBodyScore = existingHasBody ? existing.score : 0;
        const resultBodyScore = resultHasBody ? result.score : 0;
        existing.textScore = Math.max(existing.textScore, result.textScore);
        existing.pathScore = Math.max(existing.pathScore, result.pathScore);
        existing.exactPathSpecificity = Math.max(
          existing.exactPathSpecificity,
          result.exactPathSpecificity,
        ) as ExactPathSpecificity;
        const bodyScore = Math.max(existingBodyScore, resultBodyScore);
        existing.score = bodyScore > 0 ? bodyScore : existing.pathScore;
        // Path hits project the first chunk; keep a real body-match snippet
        // authoritative when both retrieval surfaces find the same document.
        if (
          (resultHasBody && !existingHasBody) ||
          (resultHasBody === existingHasBody && result.snippet.length > existing.snippet.length)
        ) {
          existing.snippet = result.snippet;
        }
      }
    }
    const merged = [...seenIds.values()];
    if (exactPathQuery !== undefined) {
      // Fallback terms broaden lexical recall, but only the original user query
      // can claim exact path, basename, or stem precedence.
      for (const result of merged) {
        result.exactPathSpecificity = resolveExactPathSpecificity(exactPathQuery, result.path);
      }
    }
    for (const result of merged) {
      if (result.textScore === 0) {
        // A uniform exact-only baseline lets temporal decay order otherwise
        // equivalent filename hits without reusing incomparable path BM25.
        result.score = result.exactPathSpecificity > 0 ? 1 : result.pathScore;
      }
    }
    return merged.toSorted(compareKeywordSearchHits);
  }

  private limitKeywordSearchHits(
    results: KeywordSearchHit[],
    nonExactLimit: number,
  ): KeywordSearchHit[] {
    const ranked = results.toSorted(compareKeywordSearchHits);
    const exactBody = ranked
      .filter((entry) => entry.exactPathSpecificity > 0 && entry.textScore > 0)
      .slice(0, nonExactLimit);
    const exactPathOnly = ranked.filter(
      (entry) => entry.exactPathSpecificity > 0 && entry.textScore === 0,
    );
    const boundedExact = exactBody.concat(exactPathOnly).toSorted(compareKeywordSearchHits);
    const selectedPathKeys = new Set<string>();
    for (const entry of boundedExact) {
      selectedPathKeys.add(`${entry.source}:${entry.path}`);
      if (selectedPathKeys.size === EXACT_PATH_CANDIDATE_LIMIT) {
        break;
      }
    }
    const exact = boundedExact.filter((entry) =>
      selectedPathKeys.has(`${entry.source}:${entry.path}`),
    );
    const nonExact = ranked
      .filter((entry) => entry.exactPathSpecificity === 0)
      .slice(0, nonExactLimit);
    return exact.concat(nonExact);
  }

  protected toMemorySearchResults(results: KeywordSearchHit[]): MemorySearchResult[] {
    return results.map(
      ({
        id: _id,
        pathScore: _pathScore,
        exactPathSpecificity: _exactPathSpecificity,
        ...result
      }) => result,
    );
  }
}
