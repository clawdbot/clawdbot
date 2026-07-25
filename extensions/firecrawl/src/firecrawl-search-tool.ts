// Firecrawl plugin module implements firecrawl search tool behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runFirecrawlSearch } from "./firecrawl-client.js";

const FirecrawlSearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Integer({
        description: "Number of results to return (1-100).",
        minimum: 1,
        maximum: 100,
      }),
    ),
    sources: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional sources list, for example ["web"], ["news"], or ["images"].',
      }),
    ),
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional Firecrawl categories, for example ["github"] or ["research"].',
      }),
    ),
    includeDomains: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Restrict results to these hostnames (no protocol or path). Cannot be combined with excludeDomains.",
      }),
    ),
    excludeDomains: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Exclude these hostnames from results (no protocol or path). Cannot be combined with includeDomains.",
      }),
    ),
    tbs: Type.Optional(
      Type.String({
        description:
          'Time-based filter, for example "qdr:d" (day), "qdr:w" (week), "qdr:m", "qdr:y", or "sbd:1" to sort by date.',
      }),
    ),
    location: Type.Optional(
      Type.String({
        description:
          'Geo-target location, for example "Germany" or "San Francisco,California,United States".',
      }),
    ),
    country: Type.Optional(
      Type.String({
        description: 'ISO country code for geo-targeting, for example "US", "DE", or "JP".',
      }),
    ),
    scrapeResults: Type.Optional(
      Type.Boolean({
        description: "Include scraped result content when Firecrawl returns it.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description: "Timeout in seconds for the Firecrawl Search request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFirecrawlSearchTool(api: OpenClawPluginApi) {
  return {
    name: "firecrawl_search",
    label: "Firecrawl Search",
    description:
      "Search the web using Firecrawl v2/search. Can optionally include scraped content from result pages.",
    parameters: FirecrawlSearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const count = readPositiveIntegerParam(rawParams, "count", {
        max: 100,
        message: "count must be an integer from 1 to 100",
      });
      const timeoutSeconds = readPositiveIntegerParam(rawParams, "timeoutSeconds");
      const sources = readStringArrayParam(rawParams, "sources");
      const categories = readStringArrayParam(rawParams, "categories");
      const includeDomains = readStringArrayParam(rawParams, "includeDomains");
      const excludeDomains = readStringArrayParam(rawParams, "excludeDomains");
      const tbs = readStringParam(rawParams, "tbs");
      const location = readStringParam(rawParams, "location");
      const country = readStringParam(rawParams, "country");
      const scrapeResults = rawParams.scrapeResults === true;

      return jsonResult(
        await runFirecrawlSearch({
          cfg: api.config,
          query,
          count,
          timeoutSeconds,
          sources,
          categories,
          includeDomains,
          excludeDomains,
          tbs,
          location,
          country,
          scrapeResults,
        }),
      );
    },
  };
}
