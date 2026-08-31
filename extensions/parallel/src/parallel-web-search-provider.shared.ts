import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const PARALLEL_CREDENTIAL_PATH = "plugins.entries.parallel.config.webSearch.apiKey";
const PARALLEL_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createParallelWebSearchProviderBase() {
  return {
    id: "parallel",
    label: "Parallel Search",
    hint: "LLM-optimized dense excerpts from web sources",
    onboardingScopes: [...PARALLEL_ONBOARDING_SCOPES],
    credentialLabel: "Parallel API key",
    envVars: ["PARALLEL_API_KEY"],
    placeholder: "par-...",
    signupUrl: "https://platform.parallel.ai",
    docsUrl: "https://docs.openclaw.ai/tools/parallel-search",
    autoDetectOrder: 75,
    credentialPath: PARALLEL_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: PARALLEL_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "parallel" },
      configuredCredential: { pluginId: "parallel" },
      selectionPluginId: "parallel",
    }),
  };
}
