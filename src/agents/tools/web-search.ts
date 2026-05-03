import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/plugin-registry.js";
import { getActiveRuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { resolveWebSearchProviderId, runWebSearch } from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult } from "./common.js";
import { MAX_SEARCH_COUNT, SEARCH_CACHE } from "./web-search-provider-common.js";

const WebSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return.",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    },
    country: {
      type: "string",
      description: "2-letter country code for region-specific results.",
    },
    language: {
      type: "string",
      description: "ISO 639-1 language code for results.",
    },
    freshness: {
      type: "string",
      description: "Filter by time: day, week, month, or year.",
    },
    date_after: {
      type: "string",
      description: "Only results published after this date (YYYY-MM-DD).",
    },
    date_before: {
      type: "string",
      description: "Only results published before this date (YYYY-MM-DD).",
    },
    search_lang: {
      type: "string",
      description: "Brave search result language code.",
    },
    ui_lang: {
      type: "string",
      description: "Brave UI locale code in language-region format.",
    },
    domain_filter: {
      type: "array",
      items: { type: "string" },
      description: "Perplexity native Search API domain filter.",
    },
    max_tokens: {
      type: "number",
      description: "Perplexity native Search API total content budget.",
      minimum: 1,
      maximum: 1000000,
    },
    max_tokens_per_page: {
      type: "number",
      description: "Perplexity native Search API max tokens extracted per page.",
      minimum: 1,
    },
  },
} satisfies Record<string, unknown>;

function isWebSearchDisabled(config?: OpenClawConfig): boolean {
  const search = config?.tools?.web?.search;
  return Boolean(search && typeof search === "object" && search.enabled === false);
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  lateBindRuntimeConfig?: boolean;
}): AnyAgentTool | null {
  if (isWebSearchDisabled(options?.config)) {
    return null;
  }

  return {
    label: "Web Search",
    name: "web_search",
    description:
      "Search the web. Returns provider-normalized results for current information lookup.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args, signal) => {
      const runtimeWebSearch =
        options?.lateBindRuntimeConfig === true
          ? getActiveRuntimeWebToolsMetadata()?.search
          : options?.runtimeWebSearch;
      const runtimeProviderId =
        runtimeWebSearch?.selectedProvider ?? runtimeWebSearch?.providerConfigured;
      const config =
        options?.lateBindRuntimeConfig === true
          ? (getActiveSecretsRuntimeSnapshot()?.config ?? options?.config)
          : options?.config;
      const preferRuntimeProviders =
        Boolean(runtimeProviderId) &&
        !resolveManifestContractOwnerPluginId({
          contract: "webSearchProviders",
          value: runtimeProviderId,
          origin: "bundled",
          config,
        });
      const result = await runWebSearch({
        config,
        sandboxed: options?.sandboxed,
        runtimeWebSearch,
        preferRuntimeProviders,
        args: asToolParamsRecord(args),
        signal,
      });
      return jsonResult({
        ...result.result,
        provider: result.provider,
      });
    },
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};
