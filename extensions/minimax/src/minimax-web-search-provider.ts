import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const MINIMAX_CREDENTIAL_PATH = "plugins.entries.minimax.config.webSearch.apiKey";
const MINIMAX_CODING_PLAN_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"] as const;

type MiniMaxWebSearchRuntime = typeof import("./minimax-web-search-provider.runtime.js");

let miniMaxWebSearchRuntimePromise: Promise<MiniMaxWebSearchRuntime> | undefined;

function loadMiniMaxWebSearchRuntime(): Promise<MiniMaxWebSearchRuntime> {
  miniMaxWebSearchRuntimePromise ??= import("./minimax-web-search-provider.runtime.js");
  return miniMaxWebSearchRuntimePromise;
}

const MiniMaxSearchSchema = {
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
} satisfies Record<string, unknown>;

export function createMiniMaxWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax Search",
    hint: "Structured results via MiniMax Coding Plan search API",
    credentialLabel: "MiniMax Coding Plan key",
    envVars: [...MINIMAX_CODING_PLAN_ENV_VARS],
    placeholder: "sk-cp-...",
    signupUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    docsUrl: "https://docs.openclaw.ai/tools/minimax-search",
    autoDetectOrder: 15,
    credentialPath: MINIMAX_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: MINIMAX_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "minimax" },
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using MiniMax Search API. Returns titles, URLs, snippets, and related search suggestions.",
      parameters: MiniMaxSearchSchema,
      execute: async (args) => {
        const { executeMiniMaxWebSearchProviderTool } = await loadMiniMaxWebSearchRuntime();
        return await executeMiniMaxWebSearchProviderTool(ctx, args);
      },
    }),
  };
}
