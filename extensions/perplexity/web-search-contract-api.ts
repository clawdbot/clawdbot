import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

export function createPerplexityWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.perplexity.config.webSearch.apiKey";

  return {
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Requires Perplexity API key or OpenRouter API key · structured results",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Perplexity API key",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    docsUrl: "https://docs.openclaw.ai/perplexity",
    autoDetectOrder: 50,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "perplexity" },
      configuredCredential: { pluginId: "perplexity" },
    }),
    createTool: () => null,
  };
}
