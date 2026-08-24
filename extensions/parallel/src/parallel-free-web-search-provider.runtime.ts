import {
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { PARALLEL_MCP_SEARCH_URL, runParallelMcpSearch } from "./parallel-mcp-search.runtime.js";
import {
  buildParallelCacheKey,
  buildParallelSearchPayload,
  PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
  normalizeParallelSearchRequest,
  stripParallelGeneratedSessionId,
} from "./parallel-search-normalize.js";

export async function executeParallelFreeWebSearchProviderTool(
  ctx: { config?: Record<string, unknown>; searchConfig?: SearchConfigRecord },
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const searchConfig = mergeScopedSearchConfig(
    ctx.searchConfig,
    "parallel-free",
    resolveProviderWebSearchPluginConfig(ctx.config, "parallel-free"),
  ) as SearchConfigRecord | undefined;

  const request = normalizeParallelSearchRequest(
    args,
    searchConfig?.maxResults,
    PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
  );
  if ("error" in request) {
    return request.error;
  }
  const { objective, searchQueries, count, sessionId, clientModel } = request;
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
  signal?.throwIfAborted();
  const payload = buildParallelSearchPayload({
    provider: "parallel-free",
    objective,
    searchQueries,
    count,
    response,
    start,
  });

  const cachePayload = sessionId ? payload : stripParallelGeneratedSessionId(payload);
  writeCachedSearchPayload(cacheKey, cachePayload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}
