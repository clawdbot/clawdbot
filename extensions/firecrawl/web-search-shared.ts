// Firecrawl plugin module implements web search shared behavior.
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export const FIRECRAWL_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webSearch.apiKey";
export const FIRECRAWL_FETCH_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webFetch.apiKey";

export function getConfiguredFirecrawlFetchCredentialFallback(config?: {
  plugins?: { entries?: { firecrawl?: { config?: unknown } } };
}) {
  const apiKey = (
    config?.plugins?.entries?.firecrawl?.config as { webFetch?: { apiKey?: unknown } } | undefined
  )?.webFetch?.apiKey;
  return apiKey === undefined
    ? undefined
    : {
        path: FIRECRAWL_FETCH_CREDENTIAL_PATH,
        value: apiKey,
      };
}

export function buildFirecrawlWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
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
    getConfiguredCredentialFallback: getConfiguredFirecrawlFetchCredentialFallback,
  };
}
