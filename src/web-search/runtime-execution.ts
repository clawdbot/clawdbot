// Web search provider execution owns cancellation precedence and automatic fallback.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import type { RunWebSearchResult } from "./runtime-types.js";

type ExecuteWebSearchCandidatesParams = {
  candidates: readonly PluginWebSearchProviderEntry[];
  config?: OpenClawConfig;
  searchConfig?: Record<string, unknown>;
  runtimeMetadata?: RuntimeWebSearchMetadata;
  agentDir?: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  allowFallback: boolean;
};

function isStructuredAvailabilityError(result: unknown): result is { error: string } {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return false;
  }
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && /^missing_[a-z0-9_]*api_key$/i.test(error);
}

export async function executeWebSearchCandidates(
  params: ExecuteWebSearchCandidatesParams,
): Promise<RunWebSearchResult> {
  // The first candidate is the provider the caller's configuration actually
  // relies on; keep its error instead of a less-relevant fallback's.
  let firstError: unknown;
  let sawUnavailableProvider = false;

  for (const candidate of params.candidates) {
    params.signal?.throwIfAborted();
    try {
      const definition = candidate.createTool({
        config: params.config,
        agentDir: params.agentDir,
        searchConfig: params.searchConfig,
        runtimeMetadata: params.runtimeMetadata,
      });
      if (!definition) {
        if (!params.allowFallback) {
          throw new Error(`web_search provider "${candidate.id}" is not available.`);
        }
        sawUnavailableProvider = true;
        continue;
      }
      const executed = await definition.execute(params.args, { signal: params.signal });
      // Cancellation wins races with provider completion or cleanup failures. Otherwise an
      // ignored signal could return stale work or trigger another provider fallback.
      params.signal?.throwIfAborted();
      if (params.allowFallback && isStructuredAvailabilityError(executed)) {
        // Some providers report missing credentials as structured tool output.
        // Treat that like unavailable only during auto-detected fallback.
        firstError ??= new Error(
          `web_search provider "${candidate.id}" returned ${executed.error}`,
        );
        continue;
      }
      return {
        provider: candidate.id,
        result: executed,
      };
    } catch (error) {
      params.signal?.throwIfAborted();
      firstError ??= error;
      if (!params.allowFallback) {
        throw error;
      }
    }
  }

  if (sawUnavailableProvider && firstError === undefined) {
    throw new Error("web_search is enabled but no provider is currently available.");
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError));
}
