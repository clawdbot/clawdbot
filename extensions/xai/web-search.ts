import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
  type WebSearchProviderSetupContext,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const XAI_CREDENTIAL_PATH = "plugins.entries.xai.config.webSearch.apiKey";
type XaiWebSearchProviderRuntime = typeof import("./src/web-search-provider.runtime.js");

let xaiWebSearchProviderRuntimePromise: Promise<XaiWebSearchProviderRuntime> | undefined;

function loadXaiWebSearchProviderRuntime(): Promise<XaiWebSearchProviderRuntime> {
  xaiWebSearchProviderRuntimePromise ??= import("./src/web-search-provider.runtime.js");
  return xaiWebSearchProviderRuntimePromise;
}

const GenericXaiSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

async function runXaiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const runtime = await loadXaiWebSearchProviderRuntime();
  return await runtime.runXaiSearchProviderSetup(ctx);
}

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
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
    credentialPath: XAI_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: XAI_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "grok" },
      configuredCredential: { pluginId: "xai" },
    }),
    runSetup: runXaiSearchProviderSetup,
    createTool: (ctx) => ({
      description:
        "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
      parameters: GenericXaiSearchSchema,
      execute: async (args) => {
        const { executeXaiWebSearchProviderTool } = await loadXaiWebSearchProviderRuntime();
        return await executeXaiWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
