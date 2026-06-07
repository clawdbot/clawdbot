import {
  DEFAULT_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { PARALLEL_MCP_SEARCH_URL, runParallelMcpSearch } from "./parallel-mcp-search.runtime.js";
import {
  buildParallelCacheKey,
  invalidSearchQueriesPayload,
  mapParallelResults,
  normalizeParallelClientModel,
  normalizeParallelObjective,
  normalizeParallelSearchQueries,
  normalizeParallelSessionId,
  PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
  resolveParallelSearchCount,
  stripParallelGeneratedSessionId,
} from "./parallel-search-normalize.js";

export async function executeParallelFreeWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "parallel-free",
    resolveProviderWebSearchPluginConfig(ctx.config, "parallel-free"),
  ) as SearchConfigRecord | undefined;

  // Mirror the paid provider's generic `query` fallback (the operator CLI passes
  // `{ query, count }`); agent callers supply the native objective/search_queries.
  const objective = normalizeParallelObjective(readStringParam(args, "objective"));
  const cliQuery = normalizeParallelObjective(readStringParam(args, "query"));
  let searchQueries = normalizeParallelSearchQueries(readStringArrayParam(args, "search_queries"));
  if (searchQueries.length === 0 && cliQuery) {
    searchQueries = normalizeParallelSearchQueries([cliQuery]);
  }
  if (searchQueries.length === 0) {
    return invalidSearchQueriesPayload();
  }
  const requestedCount =
    readNumberParam(args, "count", { integer: true }) ??
    (typeof searchConfig?.maxResults === "number" ? searchConfig.maxResults : undefined);
  const count = resolveParallelSearchCount(requestedCount ?? DEFAULT_SEARCH_COUNT);
  const sessionId = normalizeParallelSessionId(
    readStringParam(args, "session_id"),
    PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
  );
  const clientModel = normalizeParallelClientModel(readStringParam(args, "client_model"));
  const cacheKey = buildParallelCacheKey({
    endpoint: PARALLEL_MCP_SEARCH_URL,
    objective,
    searchQueries,
    count,
    sessionId,
    clientModel,
  });
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const response = await runParallelMcpSearch({
    objective,
    searchQueries,
    maxResults: count,
    sessionId,
    modelName: clientModel,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
    signal,
  });
  const results = mapParallelResults(response);

  const payload: Record<string, unknown> = {
    ...(objective ? { objective } : {}),
    searchQueries,
    provider: "parallel-free",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "parallel-free",
      wrapped: true,
    },
    results,
  };
  if (typeof response.search_id === "string") {
    payload.searchId = response.search_id;
  }
  if (typeof response.session_id === "string") {
    payload.sessionId = response.session_id;
  }
  if (Array.isArray(response.warnings) && response.warnings.length > 0) {
    payload.warnings = response.warnings;
  }
  if (Array.isArray(response.usage) && response.usage.length > 0) {
    payload.usage = response.usage;
  }

  const cachePayload = sessionId ? payload : stripParallelGeneratedSessionId(payload);
  writeCachedSearchPayload(cacheKey, cachePayload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}
