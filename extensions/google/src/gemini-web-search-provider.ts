import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { resolveGeminiApiKey, resolveGeminiModel } from "./gemini-web-search-provider.shared.js";

const GEMINI_CREDENTIAL_PATH = "plugins.entries.google.config.webSearch.apiKey";
const GEMINI_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    country: { type: "string", description: "Not supported by Gemini." },
    language: { type: "string", description: "Not supported by Gemini." },
    freshness: { type: "string", description: "Not supported by Gemini." },
    date_after: { type: "string", description: "Not supported by Gemini." },
    date_before: { type: "string", description: "Not supported by Gemini." },
  },
  required: ["query"],
} satisfies Record<string, unknown>;

function createGeminiToolDefinition(
  searchConfig?: Record<string, unknown>,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search.",
    parameters: GEMINI_TOOL_PARAMETERS,
    execute: async (args) => {
      const { executeGeminiSearch } = await import("./gemini-web-search-provider.runtime.js");
      return await executeGeminiSearch(args, searchConfig);
    },
  };
}

export function createGeminiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "gemini",
    label: "Gemini (Google Search)",
    hint: "Requires Google Gemini API key · Google Search grounding",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Google Gemini API key",
    envVars: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 20,
    credentialPath: GEMINI_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: GEMINI_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "gemini" },
      configuredCredential: { pluginId: "google" },
    }),
    createTool: (ctx) =>
      createGeminiToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "gemini",
          resolveProviderWebSearchPluginConfig(ctx.config, "google"),
        ),
      ),
  };
}

export const __testing = {
  resolveGeminiApiKey,
  resolveGeminiModel,
} as const;
