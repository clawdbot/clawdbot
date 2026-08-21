// Web search provider execution owns cancellation precedence and automatic fallback.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { schemaDeclaresProperty } from "./provider-schema.js";
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

class UnsupportedWebSearchProviderParameterError extends Error {}

const SHARED_WEB_SEARCH_PARAMETERS = new Set([
  "query",
  "count",
  "limit",
  "country",
  "language",
  "freshness",
  "date_after",
  "date_before",
  "search_lang",
  "ui_lang",
  "domain_filter",
  "max_tokens",
  "max_tokens_per_page",
]);

function assertProviderSupportsRequestedParameters(params: {
  candidate: PluginWebSearchProviderEntry;
  definition: ReturnType<PluginWebSearchProviderEntry["createTool"]>;
  args: Record<string, unknown>;
}): void {
  if (!params.definition) {
    return;
  }
  for (const [parameter, value] of Object.entries(params.args)) {
    if (value === undefined) {
      continue;
    }
    if (SHARED_WEB_SEARCH_PARAMETERS.has(parameter)) {
      continue;
    }
    if (schemaDeclaresProperty(params.definition.parameters, parameter)) {
      continue;
    }
    throw new UnsupportedWebSearchProviderParameterError(
      `web_search parameter "${parameter}" is not supported by provider "${params.candidate.id}".`,
    );
  }
}

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
  let lastError: unknown;
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
      assertProviderSupportsRequestedParameters({
        candidate,
        definition,
        args: params.args,
      });
      const executed = await definition.execute(params.args, { signal: params.signal });
      // Cancellation wins races with provider completion or cleanup failures. Otherwise an
      // ignored signal could return stale work or trigger another provider fallback.
      params.signal?.throwIfAborted();
      if (params.allowFallback && isStructuredAvailabilityError(executed)) {
        // Some providers report missing credentials as structured tool output.
        // Treat that like unavailable only during auto-detected fallback.
        lastError = new Error(`web_search provider "${candidate.id}" returned ${executed.error}`);
        continue;
      }
      return {
        provider: candidate.id,
        result: executed,
      };
    } catch (error) {
      params.signal?.throwIfAborted();
      if (error instanceof UnsupportedWebSearchProviderParameterError) {
        throw error;
      }
      lastError = error;
      if (!params.allowFallback) {
        throw error;
      }
    }
  }

  if (sawUnavailableProvider && lastError === undefined) {
    throw new Error("web_search is enabled but no provider is currently available.");
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
