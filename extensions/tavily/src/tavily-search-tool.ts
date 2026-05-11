import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runTavilySearch } from "./tavily-client.js";
import { optionalStringEnum } from "./tavily-tool-schema.js";

type TavilyToolConfigContext = Pick<
  OpenClawPluginToolContext,
  "config" | "runtimeConfig" | "getRuntimeConfig"
>;

function resolveTavilyToolConfig(
  api: OpenClawPluginApi,
  ctx?: TavilyToolConfigContext,
): OpenClawConfig {
  return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}

const TavilySearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    search_depth: optionalStringEnum(["basic", "advanced"] as const, {
      description: 'Search depth: "basic" (default, faster) or "advanced" (more thorough).',
    }),
    topic: optionalStringEnum(["general", "news", "finance"] as const, {
      description: 'Search topic: "general" (default), "news", or "finance".',
    }),
    max_results: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: 20,
      }),
    ),
    include_answer: Type.Optional(
      Type.Boolean({
        description: "Include an AI-generated answer summary (default: false).",
      }),
    ),
    time_range: optionalStringEnum(["day", "week", "month", "year"] as const, {
      description: "Filter results by recency: 'day', 'week', 'month', or 'year'.",
    }),
    include_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Only include results from these domains.",
      }),
    ),
    exclude_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Exclude results from these domains.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createTavilySearchTool(api: OpenClawPluginApi, ctx?: TavilyToolConfigContext) {
  return {
    name: "tavily_search",
    label: "Tavily Search",
    description:
      "Search the web using Tavily Search API. Supports search depth, topic filtering, domain filters, time ranges, and AI answer summaries.",
    parameters: TavilySearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const searchDepth = readStringParam(rawParams, "search_depth") || undefined;
      const topic = readStringParam(rawParams, "topic") || undefined;
      const maxResults = readNumberParam(rawParams, "max_results", { integer: true });
      const includeAnswer = rawParams.include_answer === true;
      const timeRange = readStringParam(rawParams, "time_range") || undefined;
      const includeDomains = Array.isArray(rawParams.include_domains)
        ? (rawParams.include_domains as string[]).filter(Boolean)
        : undefined;
      const excludeDomains = Array.isArray(rawParams.exclude_domains)
        ? (rawParams.exclude_domains as string[]).filter(Boolean)
        : undefined;

      return jsonResult(
        await runTavilySearch({
          cfg: resolveTavilyToolConfig(api, ctx),
          query,
          searchDepth,
          topic,
          maxResults,
          includeAnswer,
          timeRange,
          includeDomains: includeDomains?.length ? includeDomains : undefined,
          excludeDomains: excludeDomains?.length ? excludeDomains : undefined,
        }),
      );
    },
  };
}
