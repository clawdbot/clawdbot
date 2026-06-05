// Tavily plugin module implements web search shared behavior.
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export const TAVILY_CREDENTIAL_PATH = "plugins.entries.tavily.config.webSearch.apiKey";

export function buildTavilyWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured results with domain filters and AI answer summaries",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Tavily API key",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    autoDetectOrder: 70,
    credentialPath: TAVILY_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: TAVILY_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "tavily" },
      configuredCredential: { pluginId: "tavily" },
      selectionPluginId: "tavily",
    }),
  };
}
