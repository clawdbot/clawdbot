import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.firecrawl.config.webSearch.apiKey";
  const fetchCredentialPath = "plugins.entries.firecrawl.config.webFetch.apiKey";

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
    getConfiguredCredentialFallback: (config) => {
      const apiKey = (
        config?.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey;
      return apiKey === undefined
        ? undefined
        : {
            path: fetchCredentialPath,
            value: apiKey,
          };
    },
    createTool: () => null,
  };
}
