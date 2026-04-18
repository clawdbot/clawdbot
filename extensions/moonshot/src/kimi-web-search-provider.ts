import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
  type WebSearchProviderSetupContext,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const KIMI_CREDENTIAL_PATH = "plugins.entries.moonshot.config.webSearch.apiKey";
const KimiSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    country: { type: "string", description: "Not supported by Kimi." },
    language: { type: "string", description: "Not supported by Kimi." },
    freshness: { type: "string", description: "Not supported by Kimi." },
    date_after: { type: "string", description: "Not supported by Kimi." },
    date_before: { type: "string", description: "Not supported by Kimi." },
  },
} satisfies Record<string, unknown>;

async function runKimiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const runtime = await import("./kimi-web-search-provider.runtime.js");
  return await runtime.runKimiSearchProviderSetup(ctx);
}

export function createKimiWebSearchProvider(): WebSearchProviderPlugin {
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
    credentialPath: KIMI_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: KIMI_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "kimi" },
      configuredCredential: { pluginId: "moonshot" },
    }),
    runSetup: runKimiSearchProviderSetup,
    createTool: (ctx) => ({
      description:
        "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search.",
      parameters: KimiSearchSchema,
      execute: async (args) => {
        const { executeKimiWebSearchProviderTool } =
          await import("./kimi-web-search-provider.runtime.js");
        return await executeKimiWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
