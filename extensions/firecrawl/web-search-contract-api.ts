import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.firecrawl.config.webSearch.apiKey";

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
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "firecrawl" },
      configuredCredential: { pluginId: "firecrawl" },
      selectionPluginId: "firecrawl",
    }),
    createTool: () => null,
  };
}
