import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createExaWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.exa.config.webSearch.apiKey";

  return {
    id: "exa",
    label: "Exa Search",
    hint: "Neural + keyword search with date filters and content extraction",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Exa API key",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    signupUrl: "https://exa.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 65,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "exa" },
      configuredCredential: { pluginId: "exa" },
      selectionPluginId: "exa",
    }),
    createTool: () => null,
  };
}
