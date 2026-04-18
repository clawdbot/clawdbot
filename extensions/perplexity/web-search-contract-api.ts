import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { resolvePerplexityRuntimeTransport } from "./src/perplexity-web-search-provider.shared.js";

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
    resolveRuntimeMetadata: (ctx) => ({
      perplexityTransport: resolvePerplexityRuntimeTransport({
        searchConfig: mergeScopedSearchConfig(
          ctx.searchConfig,
          "perplexity",
          resolveProviderWebSearchPluginConfig(ctx.config, "perplexity"),
        ),
        resolvedKey: ctx.resolvedCredential?.value,
        keySource: ctx.resolvedCredential?.source ?? "missing",
        fallbackEnvVar: ctx.resolvedCredential?.fallbackEnvVar,
      }),
    }),
    createTool: () => null,
  };
}
