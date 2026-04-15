import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runDuckDuckGoSearch } from "./ddg-client.js";

const DuckDuckGoSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
    region: Type.Optional(
      Type.String({
        description: "Optional DuckDuckGo region code such as us-en, uk-en, or de-de.",
      }),
    ),
    safeSearch: Type.Optional(
      Type.String({
        description: "SafeSearch level: strict, moderate, or off.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo Search (experimental)",
    hint: "Free web search fallback with no API key required",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 100,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "duckduckgo"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "duckduckgo", value),
    applySelectionConfig: (config) => enablePluginInConfig(config, "duckduckgo").config,
    createTool: (ctx) => ({
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets with no API key required.",
      parameters: DuckDuckGoSearchSchema,
      execute: async (args) =>
        await runDuckDuckGoSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          region: readStringParam(args, "region"),
          safeSearch: readStringParam(args, "safeSearch") as
            | "strict"
            | "moderate"
            | "off"
            | undefined,
        }),
    }),
  };
}
