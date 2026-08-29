import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
// Transport-agnostic Parallel search normalization shared by the paid REST
// provider (`parallel`) and the free Search MCP provider (`parallel-free`).
// Both transports return the same v1 result shape, so query/result handling
// lives here instead of being copied into each runtime.
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  readCachedSearchPayload,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  type SearchConfigRecord,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  normalizeBoundedOptionalString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

// Internal-only bounds (the model-facing tool schema declares its own copies).
const PARALLEL_MAX_SEARCH_COUNT = 40;
// Parallel v1 Search caps each search_queries entry at 200 chars, the objective
// field at 5000, and accepts up to 5 search queries. See
// https://docs.parallel.ai/search/best-practices.
const PARALLEL_MAX_SEARCH_QUERY_CHARS = 200;
const PARALLEL_MAX_OBJECTIVE_CHARS = 5000;
const PARALLEL_MAX_SEARCH_QUERIES = 5;
// Paid v1 REST accepts session ids up to 1000 chars, but the free Search MCP
// `tools/list` schema caps session_id at 100. Each runtime passes its own limit
// (and advertises it in the tool schema) so callers never send an out-of-contract id.
const PARALLEL_SESSION_ID_MAX_LENGTH = 1000;
export const PARALLEL_FREE_SESSION_ID_MAX_LENGTH = 100;
const PARALLEL_CLIENT_MODEL_MAX_LENGTH = 100;

export const normalizeParallelSessionId: (
  value: string | undefined,
  maxLength: number,
) => string | undefined = normalizeBoundedOptionalString;

type ParallelSearchResult = {
  title?: unknown;
  url?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
};

export type ParallelSearchResponse = {
  search_id?: unknown;
  session_id?: unknown;
  results?: unknown;
  warnings?: unknown;
  usage?: unknown;
};

type NormalizedParallelSearchRequest = {
  objective?: string;
  searchQueries: string[];
  count: number;
  sessionId?: string;
  clientModel?: string;
};

function normalizeParallelSearchRequest(
  args: Record<string, unknown>,
  configuredCount: unknown,
  sessionIdMaxLength: number,
): { error: ReturnType<typeof invalidSearchQueriesPayload> } | NormalizedParallelSearchRequest {
  const objective = normalizeParallelObjective(readStringParam(args, "objective"));
  const cliQuery = normalizeParallelObjective(readStringParam(args, "query"));
  let searchQueries = normalizeParallelSearchQueries(readStringArrayParam(args, "search_queries"));
  if (searchQueries.length === 0 && cliQuery) {
    searchQueries = normalizeParallelSearchQueries([cliQuery]);
  }
  if (searchQueries.length === 0) {
    return { error: invalidSearchQueriesPayload() };
  }
  return {
    objective,
    searchQueries,
    count: resolveParallelSearchCount(args, configuredCount),
    sessionId: normalizeParallelSessionId(readStringParam(args, "session_id"), sessionIdMaxLength),
    clientModel: normalizeParallelClientModel(readStringParam(args, "client_model")),
  };
}

export async function executeParallelSearchRequest(params: {
  provider: "parallel" | "parallel-free";
  endpoint: string;
  args: Record<string, unknown>;
  searchConfig: SearchConfigRecord | undefined;
  signal?: AbortSignal;
  search: (
    request: NormalizedParallelSearchRequest,
    timeoutSeconds: number,
  ) => Promise<ParallelSearchResponse>;
}): Promise<Record<string, unknown>> {
  const request = normalizeParallelSearchRequest(
    params.args,
    params.searchConfig?.maxResults,
    params.provider === "parallel"
      ? PARALLEL_SESSION_ID_MAX_LENGTH
      : PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
  );
  if ("error" in request) {
    return request.error;
  }
  const cacheKey = buildParallelCacheKey({ endpoint: params.endpoint, ...request });
  const cacheTtlMs = resolveSearchCacheTtlMs(params.searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const response = await params.search(request, resolveSearchTimeoutSeconds(params.searchConfig));
  // A provider can finish after its caller aborts; never cache that stale result.
  params.signal?.throwIfAborted();
  const payload = buildParallelSearchPayload({
    provider: params.provider,
    objective: request.objective,
    searchQueries: request.searchQueries,
    response,
    start,
  });
  const cachePayload = request.sessionId ? payload : stripParallelGeneratedSessionId(payload);
  writeCachedSearchPayload(cacheKey, cachePayload, cacheTtlMs);
  return payload;
}

export function resolveParallelSearchCount(
  args: Record<string, unknown>,
  configuredCount: unknown,
): number {
  const requestedCount = readPositiveIntegerParam(args, "count", {
    max: PARALLEL_MAX_SEARCH_COUNT,
    message: `count must be an integer from 1 to ${PARALLEL_MAX_SEARCH_COUNT}.`,
  });
  const value =
    requestedCount ??
    (typeof configuredCount === "number" ? configuredCount : DEFAULT_SEARCH_COUNT);
  return resolveIntegerOption(value, DEFAULT_SEARCH_COUNT, {
    min: 1,
    max: PARALLEL_MAX_SEARCH_COUNT,
  });
}

export function normalizeParallelObjective(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= PARALLEL_MAX_OBJECTIVE_CHARS
    ? trimmed
    : truncateUtf16Safe(trimmed, PARALLEL_MAX_OBJECTIVE_CHARS);
}

export function normalizeParallelClientModel(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= PARALLEL_CLIENT_MODEL_MAX_LENGTH
    ? trimmed
    : truncateUtf16Safe(trimmed, PARALLEL_CLIENT_MODEL_MAX_LENGTH);
}

// Parallel's API caps each entry at 200 chars and accepts up to 5 queries. We
// trim, drop empties/duplicates, truncate over-long entries to the API's hard
// limit, and cap to the API's maximum so a malformed call from the model
// doesn't 422 the request. See https://docs.parallel.ai/search/best-practices.
export function normalizeParallelSearchQueries(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of candidates) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const capped =
      trimmed.length <= PARALLEL_MAX_SEARCH_QUERY_CHARS
        ? trimmed
        : truncateUtf16Safe(trimmed, PARALLEL_MAX_SEARCH_QUERY_CHARS);
    if (seen.has(capped)) {
      continue;
    }
    seen.add(capped);
    out.push(capped);
    if (out.length === PARALLEL_MAX_SEARCH_QUERIES) {
      break;
    }
  }
  return out;
}

function invalidSearchQueriesPayload() {
  return {
    error: "invalid_search_queries",
    message:
      "search_queries must be a non-empty array of keyword strings (max 5, max 200 chars each). See https://docs.parallel.ai/search/best-practices.",
    docs: "https://docs.openclaw.ai/tools/parallel-search",
  };
}

export function normalizeParallelResults(payload: unknown): ParallelSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as ParallelSearchResponse).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is ParallelSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

/** Maps a Parallel v1 response into wrapped `web_search` result entries. */
function mapParallelResults(response: ParallelSearchResponse): Record<string, unknown>[] {
  return normalizeParallelResults(response).map((entry) => {
    const title = typeof entry.title === "string" ? entry.title : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const published =
      typeof entry.publish_date === "string" && entry.publish_date ? entry.publish_date : undefined;
    const excerpts = Array.isArray(entry.excerpts)
      ? entry.excerpts
          .filter((e): e is string => typeof e === "string")
          .map((e) => wrapWebContent(e, "web_search"))
      : [];
    const description = excerpts.join("\n\n");
    return Object.assign(
      {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description,
        siteName: resolveSiteName(url) || undefined,
      },
      published ? { published } : {},
      excerpts.length > 0 ? { excerpts } : {},
    );
  });
}

function buildParallelSearchPayload(params: {
  provider: "parallel" | "parallel-free";
  objective?: string;
  searchQueries: readonly string[];
  response: ParallelSearchResponse;
  start: number;
}): Record<string, unknown> {
  const results = mapParallelResults(params.response);
  const payload: Record<string, unknown> = {
    ...(params.objective ? { objective: params.objective } : {}),
    searchQueries: params.searchQueries,
    provider: params.provider,
    count: results.length,
    tookMs: Date.now() - params.start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results,
  };
  if (typeof params.response.search_id === "string") {
    payload.searchId = params.response.search_id;
  }
  if (typeof params.response.session_id === "string") {
    payload.sessionId = params.response.session_id;
  }
  if (Array.isArray(params.response.warnings) && params.response.warnings.length > 0) {
    payload.warnings = params.response.warnings;
  }
  if (Array.isArray(params.response.usage) && params.response.usage.length > 0) {
    payload.usage = params.response.usage;
  }
  return payload;
}

/**
 * Drops a Parallel-generated `sessionId` before caching. Identical queries from
 * unrelated tasks would otherwise share that id; caller-supplied session ids are
 * part of the cache key, so a cache hit only ever returns the matching id.
 */
function stripParallelGeneratedSessionId(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!("sessionId" in payload)) {
    return payload;
  }
  const { sessionId: _omitted, ...rest } = payload;
  void _omitted;
  return rest;
}

export function buildParallelCacheKey(params: {
  endpoint: string;
  objective?: string;
  searchQueries: readonly string[];
  count: number;
  sessionId?: string;
  clientModel?: string;
}): string {
  return buildSearchCacheKey([
    "parallel",
    // The transport endpoint (REST URL or the free MCP URL) partitions paid-REST
    // vs free-MCP and REST endpoint overrides so transports never share cached
    // payloads.
    params.endpoint,
    params.objective,
    // Join with a NUL delimiter (can't appear in normalized queries) so distinct
    // arrays like ["ab","c"] and ["a","bc"] don't collide on the same cache key.
    params.searchQueries.join("\u0000"),
    params.count,
    // Different Parallel sessions can return different ranked excerpts for the
    // same query set, so partition cached payloads by caller-provided session.
    params.sessionId,
    // Parallel tailors defaults/optimizations to client_model per its docs, so
    // partition cached payloads by it; otherwise two models hitting the same
    // query inside the cache TTL would silently share ranked excerpts.
    params.clientModel,
  ]);
}
