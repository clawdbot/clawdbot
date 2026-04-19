import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const FIRECRAWL_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webSearch.apiKey";

type FirecrawlClientModule = typeof import("./firecrawl-client.js");

let firecrawlClientModulePromise: Promise<FirecrawlClientModule> | undefined;

function loadFirecrawlClientModule(): Promise<FirecrawlClientModule> {
  firecrawlClientModulePromise ??= import("./firecrawl-client.js");
  return firecrawlClientModulePromise;
}

const GenericFirecrawlSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "firecrawl",
    label: "Firecrawl Search",
    hint: "Structured results with optional result scraping",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Firecrawl API key",
    envVars: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    signupUrl: "https://www.firecrawl.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    autoDetectOrder: 60,
    credentialPath: FIRECRAWL_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: FIRECRAWL_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "firecrawl" },
      configuredCredential: { pluginId: "firecrawl" },
      selectionPluginId: "firecrawl",
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using Firecrawl. Returns structured results with snippets from Firecrawl Search. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
      parameters: GenericFirecrawlSearchSchema,
      execute: async (args) => {
        const { runFirecrawlSearch } = await loadFirecrawlClientModule();
        return await runFirecrawlSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        });
      },
    }),
  };
}
