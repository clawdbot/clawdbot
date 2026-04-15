import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runSearxngSearch } from "./searxng-client.js";

const SearxngSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
    categories: Type.Optional(
      Type.String({
        description:
          "Optional comma-separated search categories such as general, news, or science.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "Optional language code for results such as en, de, or fr.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSearxngWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "searxng",
    label: "SearXNG Search",
    hint: "Self-hosted meta-search with no API key required",
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    credentialLabel: "SearXNG Base URL",
    envVars: ["SEARXNG_BASE_URL"],
    placeholder: "http://localhost:8080",
    signupUrl: "https://docs.searxng.org/",
    autoDetectOrder: 200,
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    inactiveSecretPaths: ["plugins.entries.searxng.config.webSearch.baseUrl"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "searxng"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "searxng", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "searxng")?.baseUrl,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "searxng", "baseUrl", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "searxng").config,
    createTool: (ctx) => ({
      description:
        "Search the web using a self-hosted SearXNG instance. Returns titles, URLs, and snippets.",
      parameters: SearxngSearchSchema,
      execute: async (args) =>
        await runSearxngSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          categories: readStringParam(args, "categories"),
          language: readStringParam(args, "language"),
        }),
    }),
  };
}
