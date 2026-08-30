// Xai provider module implements model/runtime integration.
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const XAI_WEB_SEARCH_CREDENTIAL_PATH = "plugins.entries.xai.config.webSearch.apiKey";

export function buildXaiWebSearchProviderBase(): Omit<
  WebSearchProviderPlugin,
  "createTool" | "runSetup"
> {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "Uses xAI OAuth or API key · xAI web-grounded responses",
    onboardingScopes: ["text-inference"],
    credentialLabel: "xAI API key",
    envVars: ["XAI_API_KEY"],
    authProviderId: "xai",
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: XAI_WEB_SEARCH_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: XAI_WEB_SEARCH_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "grok" },
      configuredCredential: { pluginId: "xai" },
    }),
  };
}
