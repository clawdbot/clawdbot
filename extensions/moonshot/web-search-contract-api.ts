import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

export function createKimiWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.moonshot.config.webSearch.apiKey";

  return {
    id: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Requires Moonshot / Kimi API key · Moonshot web search",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Moonshot / Kimi API key",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 40,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "kimi" },
      configuredCredential: { pluginId: "moonshot" },
    }),
    createTool: () => null,
  };
}
