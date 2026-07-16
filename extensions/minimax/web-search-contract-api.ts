import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

const MINIMAX_CODING_PLAN_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"] as const;

export function createMiniMaxWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.minimax.config.webSearch.apiKey";

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
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "minimax" },
    }),
    createTool: () => null,
  };
}
