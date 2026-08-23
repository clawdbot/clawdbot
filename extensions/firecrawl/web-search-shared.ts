// Firecrawl plugin module implements web search shared behavior.
import {
  createWebSearchProviderContractFields,
  enablePluginInConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const FIRECRAWL_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webSearch.apiKey";
const FIRECRAWL_FETCH_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webFetch.apiKey";

function getConfiguredFirecrawlFetchCredentialFallback(config?: {
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
  const contractFields = createWebSearchProviderContractFields({
    credentialPath: FIRECRAWL_CREDENTIAL_PATH,
    searchCredential: { type: "scoped", scopeId: "firecrawl" },
    configuredCredential: { pluginId: "firecrawl" },
  });

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
    ...contractFields,
    applySelectionConfig: (config) => {
      const enabled = enablePluginInConfig(config, "firecrawl");
      if (!enabled.enabled || enabled.config.tools?.web?.fetch?.provider) {
        return enabled.config;
      }
      return {
        ...enabled.config,
        tools: {
          ...enabled.config.tools,
          web: {
            ...enabled.config.tools?.web,
            fetch: {
              ...enabled.config.tools?.web?.fetch,
              provider: "firecrawl",
            },
          },
        },
      };
    },
    getConfiguredCredentialFallback: getConfiguredFirecrawlFetchCredentialFallback,
  };
}

export function buildFirecrawlFreeWebSearchProviderBase(): Omit<
  WebSearchProviderPlugin,
  "createTool"
> {
  return {
    id: "firecrawl-free",
    label: "Firecrawl Search (Free)",
    hint: "Free web search via Firecrawl's hosted starter tier — no API key required",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://www.firecrawl.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "scoped", scopeId: "firecrawl-free" },
      selectionPluginId: "firecrawl",
    }),
  };
}
