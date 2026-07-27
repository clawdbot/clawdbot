// Qa Lab provider module implements deterministic QA-only web_search behavior.
import {
  MAX_SEARCH_COUNT,
  readPositiveIntegerParam,
  readStringParam,
  resolveSiteName,
  wrapWebContent,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  createQaLabWebSearchProviderBase,
  QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY,
} from "./qa-web-search-provider.shared.js";

export { QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY } from "./qa-web-search-provider.shared.js";

const QaLabWebSearchSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "Search query string.",
    },
    count: {
      type: "integer",
      description: "Number of deterministic QA results to return.",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

function buildQaLabSearchResult(query: string, index: number) {
  const url = `https://docs.openclaw.ai/qa-lab/search-fixture/${index + 1}`;
  return {
    title: wrapWebContent(`QA Lab search fixture result ${index + 1}`, "web_search"),
    url,
    description: wrapWebContent(
      `Deterministic QA Lab web_search result for query: ${query}`,
      "web_search",
    ),
    siteName: resolveSiteName(url) || "docs.openclaw.ai",
  };
}

export function createQaLabWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createQaLabWebSearchProviderBase(),
    createTool: () => ({
      description:
        "Search a deterministic QA Lab fixture corpus. This provider is for QA runtime parity only and never calls the public web.",
      parameters: QaLabWebSearchSchema,
      execute: async (args) => {
        const query = readStringParam(args, "query", { required: true });
        if (query === QA_LAB_WEB_SEARCH_DENIED_INPUT_QUERY) {
          throw new Error("QA Lab web_search denied input sentinel");
        }
        const count =
          readPositiveIntegerParam(args, "count", {
            max: MAX_SEARCH_COUNT,
            message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
          }) ?? 1;
        return {
          query,
          results: Array.from({ length: count }, (_entry, index) =>
            buildQaLabSearchResult(query, index),
          ),
        };
      },
    }),
  };
}
