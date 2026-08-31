import {
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type SearchConfigRecord,
} from "openclaw/plugin-sdk/provider-web-search";
import { PARALLEL_MCP_SEARCH_URL, runParallelMcpSearch } from "./parallel-mcp-search.runtime.js";
import { executeParallelSearchRequest } from "./parallel-search-normalize.js";

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

  return executeParallelSearchRequest({
    provider: "parallel-free",
    endpoint: PARALLEL_MCP_SEARCH_URL,
    args,
    searchConfig,
    signal,
    search: ({ count, clientModel, ...request }, timeoutSeconds) =>
      runParallelMcpSearch({
        ...request,
        maxResults: count,
        modelName: clientModel,
        timeoutSeconds,
        signal,
      }),
  });
}
