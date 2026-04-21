import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createDuckDuckGoWebSearchProviderBase } from "./ddg-search-provider.shared.js";

type DuckDuckGoClientModule = typeof import("./ddg-client.js");

let duckDuckGoClientModulePromise: Promise<DuckDuckGoClientModule> | undefined;

function loadDuckDuckGoClientModule(): Promise<DuckDuckGoClientModule> {
  duckDuckGoClientModulePromise ??= import("./ddg-client.js");
  return duckDuckGoClientModulePromise;
}

const DuckDuckGoSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    region: {
      type: "string",
      description: "Optional DuckDuckGo region code such as us-en, uk-en, or de-de.",
    },
    safeSearch: {
      type: "string",
      description: "SafeSearch level: strict, moderate, or off.",
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createDuckDuckGoWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets with no API key required.",
      parameters: DuckDuckGoSearchSchema,
      execute: async (args) => {
        const { runDuckDuckGoSearch } = await loadDuckDuckGoClientModule();
        return await runDuckDuckGoSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          region: readStringParam(args, "region"),
          safeSearch: readStringParam(args, "safeSearch") as
            | "strict"
            | "moderate"
            | "off"
            | undefined,
        });
      },
    }),
  };
}
