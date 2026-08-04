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

const CLI_FALLBACK_ARGUMENT_ALIASES = new Set(["limit"]);

function isStructuredAvailabilityError(result: unknown): result is { error: string } {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return false;
  }
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && /^missing_[a-z0-9_]*api_key$/i.test(error);
}

function asSchemaRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveUnsupportedFallbackArguments(
  parameters: unknown,
  args: Record<string, unknown>,
): string[] {
  const schema = asSchemaRecord(parameters);
  const properties = asSchemaRecord(schema?.properties);
  if (schema?.type !== "object" || !properties) {
    return [];
  }
  return Object.keys(args).filter((name) => !Object.hasOwn(properties, name));
}

function normalizeFallbackArguments(
  parameters: unknown,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = asSchemaRecord(parameters);
  const properties = asSchemaRecord(schema?.properties);
  if (schema?.type !== "object" || !properties) {
    return args;
  }
  const hasOmittedOrUnsupportedCliArgument = Object.entries(args).some(
    ([name, value]) =>
      value === undefined ||
      (CLI_FALLBACK_ARGUMENT_ALIASES.has(name) && !Object.hasOwn(properties, name)),
  );
  if (!hasOmittedOrUnsupportedCliArgument) {
    return args;
  }
  return Object.fromEntries(
    Object.entries(args).filter(
      ([name, value]) =>
        value !== undefined &&
        (!CLI_FALLBACK_ARGUMENT_ALIASES.has(name) || Object.hasOwn(properties, name)),
    ),
  );
}

export async function executeWebSearchCandidates(
  params: ExecuteWebSearchCandidatesParams,
): Promise<RunWebSearchResult> {
  let lastError: unknown;
  let sawUnavailableProvider = false;

  for (const [candidateIndex, candidate] of params.candidates.entries()) {
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
      let executionArgs = params.args;
      if (params.allowFallback && candidateIndex > 0) {
        executionArgs = normalizeFallbackArguments(definition.parameters, params.args);
        const unsupportedArguments = resolveUnsupportedFallbackArguments(
          definition.parameters,
          executionArgs,
        );
        if (unsupportedArguments.length > 0) {
          throw new Error(
            `web_search fallback provider "${candidate.id}" does not accept provider-specific arguments: ${unsupportedArguments.join(", ")}. Retry without those arguments or explicitly select a compatible provider.`,
          );
        }
      }
      const executed = await definition.execute(executionArgs, { signal: params.signal });
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
