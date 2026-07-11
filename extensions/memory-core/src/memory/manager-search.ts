// Memory Core plugin module implements manager search behavior.
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  cosineSimilarity,
  parseEmbedding,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  normalizeStringEntries,
  normalizeStringEntriesLower,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { vectorToBlob } from "./vector-blob.js";

const FTS_QUERY_TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const SHORT_CJK_TRIGRAM_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u3131-\u3163]/u;
const EXACT_PATH_SPECIFICITY_SQL_FUNCTION = "openclaw_memory_exact_path_specificity";
const NORMALIZED_PATH_CONTAINS_SQL_FUNCTION = "openclaw_memory_normalized_path_contains";
const VECTOR_KNN_OVERSAMPLE_FACTOR = 8;
// sqlite-vec v0.1.9 rejects KNN queries with k above 4096.
const MAX_VECTOR_KNN_K = 4096;

// Scan fallback vector rows in bounded batches so large chunk tables (no usable
// vec0 index) cannot pin the main thread for multi-second windows and starve
// channel I/O / liveness signals. Matches the session-indexing yield pattern
// introduced in #76978 for the same class of bug. Issue #81172.
const FALLBACK_VECTOR_BATCH_SIZE = 256;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type SearchSource = MemorySource;

type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
};

type PathKeywordSearchResult = SearchRowResult & {
  textScore: 0;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
};

function comparePathKeywordSearchResults(
  left: PathKeywordSearchResult,
  right: PathKeywordSearchResult,
): number {
  const specificityDelta = right.exactPathSpecificity - left.exactPathSpecificity;
  if (specificityDelta !== 0) {
    return specificityDelta;
  }
  if (left.exactPathSpecificity === 0) {
    const pathDelta = right.pathScore - left.pathScore;
    if (pathDelta !== 0) {
      return pathDelta;
    }
  }
  return (
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine ||
    left.id.localeCompare(right.id)
  );
}

export type ExactPathSpecificity = 0 | 1 | 2 | 3;

function normalizeSearchTokens(raw: string): string[] {
  return normalizeStringEntriesLower(raw.match(FTS_QUERY_TOKEN_RE) ?? []);
}

function scoreFallbackKeywordResult(params: {
  query: string;
  path: string;
  text: string;
  ftsScore: number;
}): number {
  const queryTokens = uniqueStrings(normalizeSearchTokens(params.query));
  if (queryTokens.length === 0) {
    return params.ftsScore;
  }

  const textTokens = normalizeSearchTokens(params.text);
  const textTokenSet = new Set(textTokens);
  const pathLower = params.path.toLowerCase();
  const overlap = queryTokens.filter((token) => textTokenSet.has(token)).length;
  const uniqueQueryOverlap = overlap / Math.max(new Set(queryTokens).size, 1);
  const density = overlap / Math.max(textTokenSet.size, 1);
  const pathBoost = queryTokens.reduce(
    (score, token) => score + (pathLower.includes(token) ? 0.18 : 0),
    0,
  );
  const textLengthBoost = Math.min(params.text.length / 160, 0.18);

  const lexicalBoost = uniqueQueryOverlap * 0.45 + density * 0.2 + pathBoost + textLengthBoost;
  return Math.min(1, params.ftsScore + lexicalBoost);
}

function escapeLikePattern(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isAscii(value: string): boolean {
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) ?? 0) > 0x7f) {
      return false;
    }
  }
  return true;
}

function resolveUnicodeCandidateAnchors(value: string): string[] {
  const firstNonAsciiCodePoint = Array.from(value).find((codePoint) => !isAscii(codePoint));
  if (!firstNonAsciiCodePoint) {
    return [];
  }
  return [
    ...new Set([
      firstNonAsciiCodePoint,
      firstNonAsciiCodePoint.toLowerCase(),
      firstNonAsciiCodePoint.toUpperCase(),
    ]),
  ];
}

function normalizePathIdentifier(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").normalize("NFC").toLowerCase();
}

export function resolveExactPathSpecificity(
  query: string,
  candidatePath: string,
): ExactPathSpecificity {
  const normalizedQuery = normalizePathIdentifier(query);
  const normalizedPath = normalizePathIdentifier(candidatePath);
  if (!normalizedQuery || normalizedQuery === ".") {
    return 0;
  }
  if (normalizedQuery === normalizedPath) {
    return 3;
  }
  if (normalizedQuery.includes("/")) {
    return 0;
  }
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (normalizedQuery === basename) {
    return 2;
  }
  const extensionIndex = basename.lastIndexOf(".");
  const stem = extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
  return normalizedQuery === stem ? 1 : 0;
}

function registerPathSearchSqlFunctions(db: DatabaseSync): void {
  // Candidate lookup and final scoring must use one Unicode-aware predicate.
  // SQLite lower()/LIKE only case-fold ASCII and would disagree with JS here.
  db.function(
    EXACT_PATH_SPECIFICITY_SQL_FUNCTION,
    { deterministic: true },
    (candidatePath, query) =>
      typeof candidatePath === "string" && typeof query === "string"
        ? resolveExactPathSpecificity(query, candidatePath)
        : 0,
  );
  db.function(
    NORMALIZED_PATH_CONTAINS_SQL_FUNCTION,
    { deterministic: true },
    (candidatePath, query) =>
      typeof candidatePath === "string" && typeof query === "string"
        ? Number(
            candidatePath
              .normalize("NFC")
              .toLowerCase()
              .includes(query.normalize("NFC").toLowerCase()),
          )
        : 0,
  );
}

type PathSubstringFilter = {
  candidateClause: string;
  candidateParams: string[];
  normalizedClause: string;
  normalizedParams: string[];
};

function buildPathSubstringFilter(params: {
  terms: string[];
  candidatePathColumn: string;
  normalizedPathColumn: string;
}): PathSubstringFilter {
  const candidateClauses: string[] = [];
  const candidateParams: string[] = [];
  const normalizedClauses: string[] = [];
  const normalizedParams: string[] = [];
  for (const term of params.terms) {
    if (isAscii(term)) {
      candidateClauses.push(`${params.candidatePathColumn} LIKE ? ESCAPE '\\'`);
      candidateParams.push(`%${escapeLikePattern(term)}%`);
      continue;
    }
    const anchors = resolveUnicodeCandidateAnchors(term);
    if (anchors.length === 0) {
      continue;
    }
    candidateClauses.push(
      `(${anchors.map(() => `${params.candidatePathColumn} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    );
    candidateParams.push(...anchors.map((anchor) => `%${escapeLikePattern(anchor)}%`));
    normalizedClauses.push(
      `${NORMALIZED_PATH_CONTAINS_SQL_FUNCTION}(${params.normalizedPathColumn}, ?) = 1`,
    );
    normalizedParams.push(term);
  }
  return {
    candidateClause: candidateClauses.map((clause) => ` AND ${clause}`).join(""),
    candidateParams,
    normalizedClause: normalizedClauses.map((clause) => ` AND ${clause}`).join(""),
    normalizedParams,
  };
}

function buildExactPathCandidatePatterns(query: string): string[] {
  const normalized = query.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") {
    return [];
  }
  const canonicalForms = [normalized.normalize("NFC"), normalized.normalize("NFD")];
  const forms = new Set(canonicalForms);
  if (!isAscii(normalized)) {
    for (const form of canonicalForms) {
      forms.add(form.toLowerCase());
      forms.add(form.toUpperCase());
    }
  }
  const patterns = new Set<string>();
  for (const form of forms) {
    const escaped = escapeLikePattern(form);
    if (normalized.includes("/")) {
      patterns.add(escaped);
      continue;
    }
    patterns.add(escaped);
    patterns.add(`${escaped}.%`);
    patterns.add(`%/${escaped}`);
    patterns.add(`%/${escaped}.%`);
  }
  if (!isAscii(normalized)) {
    const asciiAnchor = normalized
      .normalize("NFD")
      .toLowerCase()
      .match(/[a-z0-9_]+/g)
      ?.toSorted((left, right) => right.length - left.length)[0];
    if (asciiAnchor) {
      patterns.add(`%${escapeLikePattern(asciiAnchor)}%`);
    }
    if (normalized.toLowerCase() !== normalized.toUpperCase()) {
      // SQLite LIKE cannot enumerate mixed-case Unicode forms. Bound the JS
      // casefold predicate with explicit lower/upper Unicode anchors.
      for (const anchor of resolveUnicodeCandidateAnchors(normalized)) {
        patterns.add(`%${escapeLikePattern(anchor)}%`);
      }
    }
  }
  return [...patterns];
}

function buildMatchQueryFromTerms(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => `"${term.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

function readCount(row: Record<string, unknown> | undefined): number {
  if (typeof row?.count === "bigint") {
    return Number(row.count);
  }
  if (typeof row?.count === "number") {
    return row.count;
  }
  return 0;
}

function resolveProviderModels(primary: string, aliases: string[] | undefined): string[] {
  return Array.from(new Set([primary, ...(aliases ?? []).filter(Boolean)]));
}

function buildModelFilter(column: string, models: string[]): string {
  return models.length === 1
    ? `${column} = ?`
    : `${column} IN (${models.map(() => "?").join(", ")})`;
}

function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: (raw: string) => string | null;
  includeAllShortTrigramTerms?: boolean;
  includeCombiningMarks?: boolean;
}): { matchQuery: string | null; substringTerms: string[] } {
  if (params.ftsTokenizer !== "trigram") {
    return {
      matchQuery: params.buildFtsQuery(params.query),
      substringTerms: [],
    };
  }

  const tokenPattern = params.includeCombiningMarks ? /[\p{L}\p{M}\p{N}_]+/gu : FTS_QUERY_TOKEN_RE;
  const tokens = normalizeStringEntries(params.query.match(tokenPattern) ?? []);
  if (tokens.length === 0) {
    return { matchQuery: null, substringTerms: [] };
  }

  const matchTerms: string[] = [];
  const substringTerms: string[] = [];
  for (const token of tokens) {
    const isShort = Array.from(token).length < 3;
    if (isShort && (params.includeAllShortTrigramTerms || SHORT_CJK_TRIGRAM_RE.test(token))) {
      substringTerms.push(token);
      continue;
    }
    matchTerms.push(token);
  }

  return {
    matchQuery: buildMatchQueryFromTerms(matchTerms),
    substringTerms,
  };
}

function planPathKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: (raw: string) => string | null;
}): Array<{ query: string; matchQuery: string | null; substringTerms: string[] }> {
  const forms =
    params.ftsTokenizer === "trigram"
      ? new Set([params.query.normalize("NFC"), params.query.normalize("NFD")])
      : new Set([params.query]);
  const seen = new Set<string>();
  const plans: Array<{ query: string; matchQuery: string | null; substringTerms: string[] }> = [];
  const addPlan = (
    query: string,
    plan: { matchQuery: string | null; substringTerms: string[] },
  ) => {
    const key = JSON.stringify([plan.matchQuery, plan.substringTerms]);
    if (!seen.has(key)) {
      seen.add(key);
      plans.push({ query, ...plan });
    }
  };
  for (const query of forms) {
    const plan = planKeywordSearch({
      ...params,
      query,
      includeAllShortTrigramTerms: true,
      includeCombiningMarks: true,
    });
    addPlan(query, plan);
  }
  if (params.ftsTokenizer !== "trigram") {
    for (const query of new Set([params.query.normalize("NFC"), params.query.normalize("NFD")])) {
      const tokens = normalizeStringEntries(query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []);
      const substringTerms = tokens.filter((token) => !isAscii(token));
      if (substringTerms.length > 0) {
        const matchQuery = buildMatchQueryFromTerms(tokens.filter(isAscii));
        // unicode61 matches whole tokens only. Add a bounded Unicode-aware
        // substring plan while ASCII terms remain constrained by MATCH.
        addPlan(query, { matchQuery, substringTerms });
      }
    }
  }
  return plans;
}

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  providerModelAliases?: string[];
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  const providerModels = resolveProviderModels(params.providerModel, params.providerModelAliases);
  const vectorModelFilter = buildModelFilter("c.model", providerModels);
  const searchFallback = () =>
    searchChunksByEmbedding({
      db: params.db,
      providerModel: params.providerModel,
      providerModelAliases: params.providerModelAliases,
      sourceFilter: params.sourceFilterChunks,
      queryVec: params.queryVec,
      limit: params.limit,
      snippetMaxChars: params.snippetMaxChars,
    });
  if (await params.ensureVectorReady(params.queryVec.length)) {
    // Use sqlite-vec's native KNN (MATCH ? AND k = ?) for candidate selection,
    // which runs in ~O(log N + k) via the vec0 index, instead of the previous
    // full-table scan over vec_distance_cosine(). Keep vec_distance_cosine() in
    // the SELECT so `score = 1 - dist` stays in the cosine [0, 1] range the
    // downstream merge/minScore pipeline expects. (memory_index_chunks_vec is created with
    // sqlite-vec's default L2 distance, so v.distance cannot be used directly
    // for scoring.)
    const qBlob = vectorToBlob(params.queryVec);
    const runVectorQuery = (candidateLimit: number) =>
      params.db
        .prepare(
          `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
            `       c.source,\n` +
            `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
            `  FROM ${params.vectorTable} v\n` +
            `  JOIN memory_index_chunks c ON c.id = v.id\n` +
            ` WHERE v.embedding MATCH ? AND k = ? AND ${vectorModelFilter}${params.sourceFilterVec.sql}\n` +
            ` ORDER BY dist ASC\n` +
            ` LIMIT ?`,
        )
        .all(
          qBlob,
          qBlob,
          candidateLimit,
          ...providerModels,
          ...params.sourceFilterVec.params,
          params.limit,
        ) as Array<{
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        source: SearchSource;
        dist: number;
      }>;

    const candidateLimit = Math.min(params.limit * VECTOR_KNN_OVERSAMPLE_FACTOR, MAX_VECTOR_KNN_K);
    let rows = runVectorQuery(candidateLimit);
    if (rows.length < params.limit) {
      const matchingChunkCount = readCount(
        params.db
          .prepare(
            `SELECT COUNT(*) AS count FROM memory_index_chunks c WHERE ${vectorModelFilter}${params.sourceFilterVec.sql}`,
          )
          .get(...providerModels, ...params.sourceFilterVec.params),
      );
      if (matchingChunkCount > rows.length) {
        const vectorCount = readCount(
          params.db.prepare(`SELECT COUNT(*) AS count FROM ${params.vectorTable}`).get(),
        );
        const widenedLimit = Math.min(vectorCount, MAX_VECTOR_KNN_K);
        if (widenedLimit > candidateLimit) {
          rows = runVectorQuery(widenedLimit);
        }
        const requiredMatches = Math.min(params.limit, matchingChunkCount);
        if (vectorCount > MAX_VECTOR_KNN_K && rows.length < requiredMatches) {
          // Post-KNN model/source filters can hide every eligible row beyond
          // sqlite-vec's ceiling; the bounded scan preserves filtered recall.
          return await searchFallback();
        }
      }
    }

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    }));
  }

  return await searchFallback();
}

async function searchChunksByEmbedding(params: {
  db: DatabaseSync;
  providerModel: string;
  providerModelAliases?: string[];
  sourceFilter: { sql: string; params: SearchSource[] };
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
}): Promise<SearchRowResult[]> {
  if (params.limit <= 0) {
    return [];
  }
  const providerModels = resolveProviderModels(params.providerModel, params.providerModelAliases);
  const modelFilter = buildModelFilter("model", providerModels);
  // Keep batches bounded instead of calling `.all()` across the entire chunks
  // table, and do not hold a sqlite iterator open across the setImmediate yield
  // below. The rowid cursor keeps memory bounded without OFFSET rescans.
  const stmt = params.db.prepare(
    `SELECT rowid, id, path, start_line, end_line, text, embedding, source\n` +
      `  FROM memory_index_chunks\n` +
      ` WHERE ${modelFilter} AND rowid > ?${params.sourceFilter.sql}\n` +
      ` ORDER BY rowid ASC\n` +
      ` LIMIT ?`,
  );
  type ChunkEmbeddingRow = {
    rowid: number | bigint;
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  };

  const topResults: SearchRowResult[] = [];
  let lastRowid = 0;
  while (true) {
    const batch = stmt.all(
      ...providerModels,
      lastRowid,
      ...params.sourceFilter.params,
      FALLBACK_VECTOR_BATCH_SIZE,
    ) as ChunkEmbeddingRow[];
    if (batch.length === 0) {
      break;
    }
    for (const row of batch) {
      const score = cosineSimilarity(params.queryVec, parseEmbedding(row.embedding));
      if (Number.isFinite(score)) {
        const result: SearchRowResult = {
          id: row.id,
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          score,
          snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
          source: row.source,
        };
        if (topResults.length < params.limit) {
          topResults.push(result);
          if (topResults.length === params.limit) {
            topResults.sort((a, b) => b.score - a.score);
          }
        } else {
          const lowest = topResults.at(-1);
          if (lowest && result.score > lowest.score) {
            topResults[topResults.length - 1] = result;
            topResults.sort((a, b) => b.score - a.score);
          }
        }
      }
    }
    const nextRowid = batch.at(-1)?.rowid;
    lastRowid = typeof nextRowid === "bigint" ? Number(nextRowid) : (nextRowid ?? lastRowid);
    if (batch.length < FALLBACK_VECTOR_BATCH_SIZE) {
      break;
    }
    await yieldToEventLoop();
  }
  topResults.sort((a, b) => b.score - a.score);
  return topResults;
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
  boostFallbackRanking?: boolean;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const plan = planKeywordSearch({
    query: params.query,
    ftsTokenizer: params.ftsTokenizer,
    buildFtsQuery: params.buildFtsQuery,
  });
  if (!plan.matchQuery && plan.substringTerms.length === 0) {
    return [];
  }

  // Lexical FTS is model-agnostic (issue #48300), but old databases may
  // already contain orphaned FTS rows from prior model-scoped cleanup.
  const liveChunkClause = ` AND EXISTS (SELECT 1 FROM memory_index_chunks c WHERE c.id = ${params.ftsTable}.id)`;
  const substringClause = plan.substringTerms.map(() => " AND text LIKE ? ESCAPE '\\'").join("");
  const substringParams = plan.substringTerms.map((term) => `%${escapeLikePattern(term)}%`);

  let rows: Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;
  let usedMatch = false;

  if (plan.matchQuery) {
    try {
      rows = params.db
        .prepare(
          `SELECT id, path, source, start_line, end_line, text,\n` +
            `       bm25(${params.ftsTable}) AS rank\n` +
            `  FROM ${params.ftsTable}\n` +
            ` WHERE ${params.ftsTable} MATCH ?${substringClause}${liveChunkClause}${params.sourceFilter.sql}\n` +
            ` ORDER BY rank ASC\n` +
            ` LIMIT ?`,
        )
        .all(
          plan.matchQuery,
          ...substringParams,
          ...params.sourceFilter.params,
          params.limit,
        ) as typeof rows;
      usedMatch = true;
    } catch (matchErr) {
      // FTS5 MATCH can fail on certain token patterns depending on the
      // Node.js sqlite runtime and tokenizer (e.g. unicode61 vs trigram).
      // Log the root cause, then fall back to per-token LIKE-based substring
      // search so results are still returned instead of being silently dropped.
      console.warn(`memory search: FTS5 MATCH failed, falling back to LIKE: ${String(matchErr)}`);
      const queryTokens = normalizeStringEntries(params.query.match(FTS_QUERY_TOKEN_RE) ?? []);
      const allTerms = uniqueStrings([...queryTokens, ...plan.substringTerms]);
      const fallbackLikeClause = allTerms.map(() => " AND text LIKE ? ESCAPE '\\'").join("");
      const fallbackLikeParams = allTerms.map((term) => `%${escapeLikePattern(term)}%`);
      rows = params.db
        .prepare(
          `SELECT id, path, source, start_line, end_line, text,\n` +
            `       0 AS rank\n` +
            `  FROM ${params.ftsTable}\n` +
            ` WHERE 1=1${fallbackLikeClause}${liveChunkClause}${params.sourceFilter.sql}\n` +
            ` LIMIT ?`,
        )
        .all(...fallbackLikeParams, ...params.sourceFilter.params, params.limit) as typeof rows;
    }
  } else {
    rows = params.db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text,\n` +
          `       0 AS rank\n` +
          `  FROM ${params.ftsTable}\n` +
          ` WHERE 1=1${substringClause}${liveChunkClause}${params.sourceFilter.sql}\n` +
          ` LIMIT ?`,
      )
      .all(...substringParams, ...params.sourceFilter.params, params.limit) as typeof rows;
  }

  return rows.map((row) => {
    const textScore = usedMatch ? params.bm25RankToScore(row.rank) : 1;
    const score = params.boostFallbackRanking
      ? scoreFallbackKeywordResult({
          query: params.query,
          path: row.path,
          text: row.text,
          ftsScore: textScore,
        })
      : textScore;
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score,
      textScore,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    };
  });
}

export async function searchPathKeyword(params: {
  db: DatabaseSync;
  pathFtsTable: string;
  query: string;
  exactPathQuery?: string;
  exactPathLimit?: number;
  ftsTokenizer?: "unicode61" | "trigram";
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
}): Promise<PathKeywordSearchResult[]> {
  if (params.limit <= 0) {
    return [];
  }
  const pathColumn = `${params.pathFtsTable}.path`;
  const pathPlans = planPathKeywordSearch({
    query: params.query,
    ftsTokenizer: params.ftsTokenizer,
    buildFtsQuery: params.buildFtsQuery,
  });
  const plan = pathPlans[0] ?? { query: params.query, matchQuery: null, substringTerms: [] };
  const planSubstringFilter = buildPathSubstringFilter({
    terms: plan.substringTerms,
    candidatePathColumn: pathColumn,
    normalizedPathColumn: "path",
  });
  registerPathSearchSqlFunctions(params.db);
  const exactPathQuery = params.exactPathQuery ?? params.query;
  const hasExplicitExactPathHeadroom = params.exactPathLimit !== undefined;
  const exactPathLimit = Math.max(0, Math.floor(params.exactPathLimit ?? params.limit));
  const exactCandidatePatterns = buildExactPathCandidatePatterns(exactPathQuery);
  type ExactPathRow = {
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    exact_path_specificity: ExactPathSpecificity;
  };
  // ASCII identifiers use the path FTS plan before suffix filtering; Unicode
  // forms keep the LIKE fallback. Live chunks are joined before LIMIT so an
  // empty indexed file cannot consume an exact-result slot.
  const loadExactRows = (useLexicalCandidates: boolean): ExactPathRow[] => {
    const qualifiedPatternClause = exactCandidatePatterns
      .map(() => `${pathColumn} LIKE ? ESCAPE '\\'`)
      .join(" OR ");
    const candidateCtes = useLexicalCandidates
      ? `candidates AS MATERIALIZED (\n` +
        `  SELECT ${params.pathFtsTable}.path, ${params.pathFtsTable}.source\n` +
        `    FROM ${params.pathFtsTable}\n` +
        `   WHERE ${plan.matchQuery ? `${params.pathFtsTable} MATCH ?` : "1=1"}${planSubstringFilter.candidateClause}${params.sourceFilter.sql}\n` +
        `), pattern_candidates AS MATERIALIZED (\n` +
        `  SELECT path, source FROM candidates\n` +
        `   WHERE (${exactCandidatePatterns.map(() => "path LIKE ? ESCAPE '\\'").join(" OR ")})\n` +
        `)`
      : `pattern_candidates AS MATERIALIZED (\n` +
        `  SELECT ${params.pathFtsTable}.path, ${params.pathFtsTable}.source\n` +
        `    FROM ${params.pathFtsTable}\n` +
        `   WHERE (${qualifiedPatternClause})${params.sourceFilter.sql}\n` +
        `)`;
    const candidateParams = useLexicalCandidates
      ? [
          ...(plan.matchQuery ? [plan.matchQuery] : []),
          ...planSubstringFilter.candidateParams,
          ...params.sourceFilter.params,
          ...exactCandidatePatterns,
        ]
      : [...exactCandidatePatterns, ...params.sourceFilter.params];
    return params.db
      .prepare(
        `WITH ${candidateCtes}, scored_paths AS MATERIALIZED (\n` +
          `  SELECT path, source,\n` +
          `         ${EXACT_PATH_SPECIFICITY_SQL_FUNCTION}(path, ?) AS exact_path_specificity\n` +
          `    FROM pattern_candidates\n` +
          `), exact_paths AS MATERIALIZED (\n` +
          `  SELECT path, source, exact_path_specificity FROM scored_paths\n` +
          `   WHERE exact_path_specificity > 0\n` +
          `)\n` +
          `SELECT c.id, exact_paths.path, exact_paths.source,\n` +
          `       c.start_line, c.end_line, c.text, exact_paths.exact_path_specificity\n` +
          `  FROM exact_paths\n` +
          `  JOIN memory_index_chunks c ON c.id = (\n` +
          `    SELECT candidate.id FROM memory_index_chunks candidate\n` +
          `     WHERE candidate.path = exact_paths.path\n` +
          `       AND candidate.source = exact_paths.source\n` +
          `     ORDER BY candidate.start_line, candidate.end_line, candidate.id\n` +
          `     LIMIT 1\n` +
          `  )\n` +
          ` ORDER BY exact_paths.exact_path_specificity DESC,\n` +
          `          exact_paths.path ASC, exact_paths.source ASC\n` +
          ` LIMIT ?`,
      )
      .all(...candidateParams, exactPathQuery, exactPathLimit) as ExactPathRow[];
  };
  const useLexicalExactCandidates =
    isAscii(exactPathQuery) && (plan.matchQuery !== null || plan.substringTerms.length > 0);
  let exactRows: ExactPathRow[] = [];
  if (exactCandidatePatterns.length > 0 && exactPathLimit > 0) {
    try {
      exactRows = loadExactRows(useLexicalExactCandidates);
    } catch (err) {
      if (!useLexicalExactCandidates) {
        throw err;
      }
      // Tokenizer-specific MATCH failures must not suppress exact path recall.
      exactRows = loadExactRows(false);
    }
  }
  const exactResults = exactRows.map(
    (row): PathKeywordSearchResult => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 0,
      textScore: 0,
      pathScore: 0,
      exactPathSpecificity: row.exact_path_specificity,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    }),
  );
  if (!pathPlans.some((entry) => entry.matchQuery || entry.substringTerms.length > 0)) {
    return exactResults;
  }
  type PathLexicalRow = {
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  };
  const loadFilteredLexicalRows = (
    matchQuery: string | null,
    terms: string[],
    specificity: "exact" | "non-exact",
    resultLimit: number,
  ) => {
    const filter = buildPathSubstringFilter({
      terms,
      candidatePathColumn: pathColumn,
      normalizedPathColumn: "path",
    });
    const specificityOperator = specificity === "exact" ? ">" : "=";
    const qualifiedSpecificityClause = ` AND ${EXACT_PATH_SPECIFICITY_SQL_FUNCTION}(${pathColumn}, ?) ${specificityOperator} 0`;
    const normalizedSpecificityClause = ` AND ${EXACT_PATH_SPECIFICITY_SQL_FUNCTION}(path, ?) ${specificityOperator} 0`;
    const queryParams = [
      ...(matchQuery ? [matchQuery] : []),
      ...filter.candidateParams,
      ...params.sourceFilter.params,
    ];
    if (!filter.normalizedClause) {
      return params.db
        .prepare(
          `SELECT c.id, ${params.pathFtsTable}.path, ${params.pathFtsTable}.source,\n` +
            `       c.start_line, c.end_line, c.text,\n` +
            `       ${matchQuery ? `bm25(${params.pathFtsTable})` : "0"} AS rank\n` +
            `  FROM ${params.pathFtsTable}\n` +
            `  JOIN memory_index_chunks c ON c.id = (\n` +
            `    SELECT candidate.id FROM memory_index_chunks candidate\n` +
            `     WHERE candidate.path = ${params.pathFtsTable}.path\n` +
            `       AND candidate.source = ${params.pathFtsTable}.source\n` +
            `     ORDER BY candidate.start_line, candidate.end_line, candidate.id\n` +
            `     LIMIT 1\n` +
            `  )\n` +
            ` WHERE ${matchQuery ? `${params.pathFtsTable} MATCH ?` : "1=1"}${filter.candidateClause}${params.sourceFilter.sql}${qualifiedSpecificityClause}\n` +
            ` ORDER BY rank ASC, ${params.pathFtsTable}.path ASC, ${params.pathFtsTable}.source ASC\n` +
            ` LIMIT ?`,
        )
        .all(...queryParams, exactPathQuery, resultLimit) as PathLexicalRow[];
    }
    // SQLite LIKE only case-folds ASCII. Materialize a cheap first-codepoint
    // candidate set before invoking the Unicode-aware predicate.
    return params.db
      .prepare(
        `WITH path_candidates AS MATERIALIZED (\n` +
          `  SELECT ${params.pathFtsTable}.path, ${params.pathFtsTable}.source,\n` +
          `         ${matchQuery ? `bm25(${params.pathFtsTable})` : "0"} AS rank\n` +
          `    FROM ${params.pathFtsTable}\n` +
          `   WHERE ${matchQuery ? `${params.pathFtsTable} MATCH ?` : "1=1"}${filter.candidateClause}${params.sourceFilter.sql}\n` +
          `), normalized_paths AS MATERIALIZED (\n` +
          `  SELECT path, source, rank FROM path_candidates\n` +
          `   WHERE 1=1${filter.normalizedClause}${normalizedSpecificityClause}\n` +
          `)\n` +
          `SELECT c.id, normalized_paths.path, normalized_paths.source,\n` +
          `       c.start_line, c.end_line, c.text, normalized_paths.rank\n` +
          `  FROM normalized_paths\n` +
          `  JOIN memory_index_chunks c ON c.id = (\n` +
          `    SELECT candidate.id FROM memory_index_chunks candidate\n` +
          `     WHERE candidate.path = normalized_paths.path\n` +
          `       AND candidate.source = normalized_paths.source\n` +
          `     ORDER BY candidate.start_line, candidate.end_line, candidate.id\n` +
          `     LIMIT 1\n` +
          `  )\n` +
          ` ORDER BY normalized_paths.rank ASC, normalized_paths.path ASC, normalized_paths.source ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        ...queryParams,
        ...filter.normalizedParams,
        exactPathQuery,
        resultLimit,
      ) as PathLexicalRow[];
  };
  const loadLexicalRows = (lexicalPlan: (typeof pathPlans)[number]) => {
    // Partition before LIMIT so an exact-filename flood cannot consume the
    // normal lexical budget reserved for partial path matches.
    const loadPartitions = (matchQuery: string | null, terms: string[]) => [
      ...(exactPathLimit > 0
        ? loadFilteredLexicalRows(matchQuery, terms, "exact", exactPathLimit)
        : []),
      ...loadFilteredLexicalRows(matchQuery, terms, "non-exact", params.limit),
    ];
    if (lexicalPlan.matchQuery) {
      try {
        const rows = loadPartitions(lexicalPlan.matchQuery, lexicalPlan.substringTerms);
        return { rows, usedMatch: true };
      } catch (matchErr) {
        console.warn(
          `memory search: path FTS5 MATCH failed, falling back to LIKE: ${String(matchErr)}`,
        );
        const queryTokens = normalizeStringEntries(
          lexicalPlan.query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [],
        );
        const allTerms = uniqueStrings([...queryTokens, ...lexicalPlan.substringTerms]);
        const rows = loadPartitions(null, allTerms);
        return { rows, usedMatch: false };
      }
    }
    const rows = loadPartitions(null, lexicalPlan.substringTerms);
    return { rows, usedMatch: false };
  };

  const lexicalById = new Map<string, PathKeywordSearchResult>();
  for (const lexicalPlan of pathPlans) {
    if (!lexicalPlan.matchQuery && lexicalPlan.substringTerms.length === 0) {
      continue;
    }
    const { rows, usedMatch } = loadLexicalRows(lexicalPlan);
    for (const row of rows) {
      const pathScore = usedMatch ? params.bm25RankToScore(row.rank) : 1;
      const exactPathSpecificity = resolveExactPathSpecificity(exactPathQuery, row.path);
      const result: PathKeywordSearchResult = {
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: pathScore,
        textScore: 0,
        pathScore,
        exactPathSpecificity,
        snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
        source: row.source,
      };
      const existing = lexicalById.get(result.id);
      if (!existing) {
        lexicalById.set(result.id, result);
        continue;
      }
      existing.pathScore = Math.max(existing.pathScore, result.pathScore);
      existing.score = Math.max(existing.score, result.score);
      existing.exactPathSpecificity = Math.max(
        existing.exactPathSpecificity,
        result.exactPathSpecificity,
      ) as ExactPathSpecificity;
    }
  }

  const byId = new Map(exactResults.map((entry) => [entry.id, entry]));
  let nonExactCount = 0;
  for (const entry of [...lexicalById.values()].toSorted(comparePathKeywordSearchResults)) {
    const exact = byId.get(entry.id);
    if (entry.exactPathSpecificity > 0) {
      if (!exact) {
        continue;
      }
      exact.pathScore = Math.max(exact.pathScore, entry.pathScore);
      exact.score = Math.max(exact.score, entry.score);
      exact.exactPathSpecificity = Math.max(
        exact.exactPathSpecificity,
        entry.exactPathSpecificity,
      ) as ExactPathSpecificity;
      continue;
    }
    if (nonExactCount >= params.limit) {
      continue;
    }
    byId.set(entry.id, entry);
    nonExactCount += 1;
  }
  // Exact filenames get bounded headroom only when the manager explicitly
  // requests it; otherwise `limit` remains the total-result contract.
  const resultLimit = hasExplicitExactPathHeadroom ? exactPathLimit + params.limit : params.limit;
  return [...byId.values()].toSorted(comparePathKeywordSearchResults).slice(0, resultLimit);
}
