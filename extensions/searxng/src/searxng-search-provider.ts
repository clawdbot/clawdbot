import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const SEARXNG_CREDENTIAL_PATH = "plugins.entries.searxng.config.webSearch.baseUrl";

type SearxngClientModule = typeof import("./searxng-client.js");

let searxngClientModulePromise: Promise<SearxngClientModule> | undefined;

function loadSearxngClientModule(): Promise<SearxngClientModule> {
  searxngClientModulePromise ??= import("./searxng-client.js");
  return searxngClientModulePromise;
}

const SearxngSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    categories: {
      type: "string",
      description: "Optional comma-separated search categories such as general, news, or science.",
    },
    language: {
      type: "string",
      description: "Optional language code for results such as en, de, or fr.",
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

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
    credentialPath: SEARXNG_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: SEARXNG_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "searxng" },
      configuredCredential: { pluginId: "searxng", field: "baseUrl" },
      selectionPluginId: "searxng",
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using a self-hosted SearXNG instance. Returns titles, URLs, and snippets.",
      parameters: SearxngSearchSchema,
      execute: async (args) => {
        const { runSearxngSearch } = await loadSearxngClientModule();
        return await runSearxngSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          categories: readStringParam(args, "categories"),
          language: readStringParam(args, "language"),
        });
      },
    }),
  };
}
