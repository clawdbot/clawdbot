import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.xai.config.webSearch.apiKey";

  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "Requires xAI API key · xAI web-grounded responses",
    onboardingScopes: ["text-inference"],
    credentialLabel: "xAI API key",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "grok" },
      configuredCredential: { pluginId: "xai" },
    }),
    createTool: () => null,
  };
}
