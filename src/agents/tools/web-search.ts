/**
 * web_search built-in tool.
 *
 * Runs the configured runtime provider and returns normalized cached search results.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { hasConfiguredWebSearchCredential } from "../../plugins/web-search-credential-presence.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { runtimeWebSecretOwnerId } from "../../secrets/runtime-web-secret-owner.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  truncateSanitizedExternalContent,
  wrapWebContent,
} from "../../security/external-content.js";
import { resolveWebSearchDefinition, runWebSearch } from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { asToolParamsRecord, jsonResult, textResult } from "./common.js";
import { normalizeWebSearchOutput, WebSearchOutputSchema } from "./web-search-output.js";
import { MAX_SEARCH_COUNT } from "./web-search-provider-common.js";
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

type WebSearchToolOptions = {
  config?: OpenClawConfig;
  enabled?: boolean;
  agentDir?: string;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  lateBindRuntimeConfig?: boolean;
};

function isWebSearchDisabled(config?: OpenClawConfig): boolean {
  const search = config?.tools?.web?.search;
  return Boolean(search && typeof search === "object" && search.enabled === false);
}

function hasConfiguredWebSearchProviderSignal(config?: OpenClawConfig): boolean {
  const resolvedConfig = config ?? {};
  return hasConfiguredWebSearchCredential({
    config: resolvedConfig,
    env: process.env,
  });
}

function shouldResolveWebSearchModelParameters(params: {
  config?: OpenClawConfig;
  providerSelectionId: string;
}): boolean {
  return Boolean(
    params.providerSelectionId.trim() ||
    getActivePluginRegistry()?.webSearchProviders.length ||
    hasConfiguredWebSearchProviderSignal(params.config),
  );
}

function resolveWebSearchModelParameters(
  options: WebSearchToolOptions | undefined,
): AnyAgentTool["parameters"] {
  const { config, preferRuntimeProviders, providerSelectionId, runtimeWebSearch } =
    resolveWebSearchToolRuntimeContext({
      config: options?.config,
      lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
      runtimeWebSearch: options?.runtimeWebSearch,
    });
  // A generic schema read must not trigger an unscoped plugin source load. A
  // selected, registered, or config-backed provider still resolves through the
  // same candidate path as execution so metadata-free auto-detection works.
  if (!shouldResolveWebSearchModelParameters({ config, providerSelectionId })) {
    return WebSearchSchema;
  }
  return (
    resolveWebSearchDefinition({
      config,
      agentDir: options?.agentDir,
      sandboxed: options?.sandboxed,
      runtimeWebSearch,
      preferRuntimeProviders,
    })?.definition.parameters ?? WebSearchSchema
  );
}

/** Creates the `web_search` tool, or `null` when web search is disabled by config. */
export function createWebSearchTool(options?: WebSearchToolOptions): AnyAgentTool | null {
  if (options?.enabled === false || isWebSearchDisabled(options?.config)) {
    return null;
  }

  return {
    label: "Web Search",
    name: "web_search",
    resultContentSource: "network",
    description:
      "Search current web and return normalized provider results. Available filters depend on the active provider.",
    get parameters() {
      return resolveWebSearchModelParameters(options);
    },
    outputSchema: WebSearchOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      // Late binding lets long-lived agents pick up runtime web-search credentials/config without
      // rebuilding the tool object.
      const { config, preferRuntimeProviders, providerSelectionId, runtimeWebSearch } =
        resolveWebSearchToolRuntimeContext({
          config: options?.config,
          lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
          runtimeWebSearch: options?.runtimeWebSearch,
        });
      if (isWebSearchDisabled(config)) {
        throw new Error("web_search is disabled.");
      }
      if (providerSelectionId) {
        assertSecretOwnerAvailable(
          "capability",
          runtimeWebSecretOwnerId("search", providerSelectionId),
        );
      }
      const toolArgs = asToolParamsRecord(args);
      const result = await runWebSearch({
        config,
        agentDir: options?.agentDir,
        sandboxed: options?.sandboxed,
        runtimeWebSearch,
        preferRuntimeProviders,
        args: toolArgs,
        signal,
      });
      const normalized = normalizeWebSearchOutput({
        result: result.result,
        provider: result.provider,
        query: typeof toolArgs.query === "string" ? toolArgs.query : "",
      });
      if (normalized.kind !== "raw") {
        return jsonResult(normalized);
      }
      const rawText = JSON.stringify(normalized, null, 2);
      const bounded = truncateSanitizedExternalContent(rawText, 20_000);
      const modelText = bounded.truncated
        ? `${truncateSanitizedExternalContent(rawText, 19_988).text}\n[truncated]`
        : bounded.text;
      return textResult(wrapWebContent(modelText, "web_search"), normalized);
    },
  };
}
