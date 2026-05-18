import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { resolveWebSearchProviderId, runWebSearch } from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult } from "./common.js";
import { MAX_SEARCH_COUNT, SEARCH_CACHE } from "./web-search-provider-common.js";
import { resolveWebSearchToolRuntimeContext } from "./web-tool-runtime-context.js";

const WebSearchSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Search query." },
    count: {
      type: "number",
      description: "Result count.",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    },
    country: {
      type: "string",
      description: "2-letter country code.",
    },
    language: {
      type: "string",
      description: "ISO 639-1 language.",
    },
    freshness: {
      type: "string",
      description: "Time filter: day/week/month/year.",
    },
    date_after: {
      type: "string",
      description: "Published after YYYY-MM-DD.",
    },
    date_before: {
      type: "string",
      description: "Published before YYYY-MM-DD.",
    },
    search_lang: {
      type: "string",
      description: "Brave result language.",
    },
    ui_lang: {
      type: "string",
      description: "Brave UI locale.",
    },
    domain_filter: {
      type: "array",
      items: { type: "string" },
      description: "Perplexity domain filter.",
    },
    max_tokens: {
      type: "number",
      description: "Perplexity total token budget.",
      minimum: 1,
      maximum: 1000000,
    },
    max_tokens_per_page: {
      type: "number",
      description: "Perplexity tokens per page.",
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
    description: "Search web for current info; returns normalized provider results.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args, signal) => {
      const { config, preferRuntimeProviders, runtimeWebSearch } =
        resolveWebSearchToolRuntimeContext({
          config: options?.config,
          lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
          runtimeWebSearch: options?.runtimeWebSearch,
        });
      if (isWebSearchDisabled(config)) {
        throw new Error("web_search is disabled.");
      }
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
