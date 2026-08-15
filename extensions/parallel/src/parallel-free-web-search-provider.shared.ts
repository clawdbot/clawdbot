import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const PARALLEL_FREE_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createParallelFreeWebSearchProviderBase() {
  return {
    id: "parallel-free",
    label: "Parallel Search (Free)",
    hint: "Free web search via Parallel's hosted Search MCP — no API key required",
    onboardingScopes: [...PARALLEL_FREE_ONBOARDING_SCOPES],
    // Keyless: always uses Parallel's free hosted Search MCP. Keep it
    // selectable, but never auto-detected; users must opt in before search
    // traffic is sent to Parallel's hosted free tier. The paid `parallel`
    // provider (v1 REST, requires a key) is a separate entry.
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://parallel.ai",
    docsUrl: "https://docs.openclaw.ai/tools/parallel-search",
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "scoped", scopeId: "parallel-free" },
      // Both Parallel providers live in the `parallel` plugin.
      selectionPluginId: "parallel",
    }),
  };
}
