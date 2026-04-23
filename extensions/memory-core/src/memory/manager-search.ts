import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  cosineSimilarity,
  parseEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);
const FTS_QUERY_TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const SHORT_CJK_TRIGRAM_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u3131-\u3163]/u;
const VECTOR_KNN_OVERSAMPLE_FACTOR = 8;

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
};

function normalizeSearchTokens(raw: string): string[] {
  return (
    raw
      .match(FTS_QUERY_TOKEN_RE)
      ?.map((token) => token.trim().toLowerCase())
      .filter(Boolean) ?? []
  );
}

function scoreFallbackKeywordResult(params: {
  query: string;
  path: string;
  text: string;
  ftsScore: number;
}): number {
  const queryTokens = [...new Set(normalizeSearchTokens(params.query))];
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

function buildMatchQueryFromTerms(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => `"${term.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

function readCount(row: { count?: number | bigint } | undefined): number {
  if (typeof row?.count === "bigint") {
    return Number(row.count);
  }
  if (typeof row?.count === "number") {
    return row.count;
  }
  return 0;
}

function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: (raw: string) => string | null;
}): { matchQuery: string | null; substringTerms: string[] } {
  if (params.ftsTokenizer !== "trigram") {
    return {
      matchQuery: params.buildFtsQuery(params.query),
      substringTerms: [],
    };
  }

  const tokens =
    params.query
      .match(FTS_QUERY_TOKEN_RE)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return { matchQuery: null, substringTerms: [] };
  }

  const matchTerms: string[] = [];
  const substringTerms: string[] = [];
  for (const token of tokens) {
    if (SHORT_CJK_TRIGRAM_RE.test(token) && Array.from(token).length < 3) {
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

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
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
  if (await params.ensureVectorReady(params.queryVec.length)) {
    // Use sqlite-vec's native KNN (MATCH ? AND k = ?) for candidate selection,
    // which runs in ~O(log N + k) via the vec0 index, instead of the previous
    // full-table scan over vec_distance_cosine(). Keep vec_distance_cosine() in
    // the SELECT so `score = 1 - dist` stays in the cosine [0, 1] range the
    // downstream merge/minScore pipeline expects. (chunks_vec is created with
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
            `  JOIN chunks c ON c.id = v.id\n` +
            ` WHERE v.embedding MATCH ? AND k = ? AND c.model = ?${params.sourceFilterVec.sql}\n` +
            ` ORDER BY dist ASC\n` +
            ` LIMIT ?`,
        )
        .all(
          qBlob,
          qBlob,
          candidateLimit,
          params.providerModel,
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

    const candidateLimit = params.limit * VECTOR_KNN_OVERSAMPLE_FACTOR;
    let rows = runVectorQuery(candidateLimit);
    if (rows.length < params.limit) {
      const matchingChunkCount = readCount(
        params.db
          .prepare(
            `SELECT COUNT(*) AS count FROM chunks c WHERE c.model = ?${params.sourceFilterVec.sql}`,
          )
          .get(params.providerModel, ...params.sourceFilterVec.params) as
          | { count?: number | bigint }
          | undefined,
      );
      if (matchingChunkCount > rows.length) {
        const vectorCount = readCount(
          params.db.prepare(`SELECT COUNT(*) AS count FROM ${params.vectorTable}`).get() as
            | { count?: number | bigint }
            | undefined,
        );
        if (vectorCount > candidateLimit) {
          rows = runVectorQuery(vectorCount);
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

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
    }));
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
}> {
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
  }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string | undefined;
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

  // When providerModel is undefined (FTS-only mode), search all models
  const modelClause = params.providerModel ? " AND model = ?" : "";
  const modelParams = params.providerModel ? [params.providerModel] : [];
  const substringClause = plan.substringTerms.map(() => " AND text LIKE ? ESCAPE '\\'").join("");
  const substringParams = plan.substringTerms.map((term) => `%${escapeLikePattern(term)}%`);
  const whereClause = plan.matchQuery
    ? `${params.ftsTable} MATCH ?${substringClause}${modelClause}${params.sourceFilter.sql}`
    : `1=1${substringClause}${modelClause}${params.sourceFilter.sql}`;
  const queryParams = [
    ...(plan.matchQuery ? [plan.matchQuery] : []),
    ...substringParams,
    ...modelParams,
    ...params.sourceFilter.params,
    params.limit,
  ];
  const rankExpression = plan.matchQuery ? `bm25(${params.ftsTable})` : "0";

  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       ${rankExpression} AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${whereClause}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(...queryParams) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return rows.map((row) => {
    const textScore = plan.matchQuery ? params.bm25RankToScore(row.rank) : 1;
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
