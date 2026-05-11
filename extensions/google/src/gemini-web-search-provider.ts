import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  resolveGeminiApiKey,
  resolveGeminiBaseUrl,
  resolveGeminiModel,
} from "./gemini-web-search-provider.shared.js";

const GEMINI_CREDENTIAL_PATH = "plugins.entries.google.config.webSearch.apiKey";
const GOOGLE_PROVIDER_CREDENTIAL_PATH = "models.providers.google.apiKey";

type GeminiWebSearchRuntime = typeof import("./gemini-web-search-provider.runtime.js");

let geminiWebSearchRuntimePromise: Promise<GeminiWebSearchRuntime> | undefined;

function loadGeminiWebSearchRuntime(): Promise<GeminiWebSearchRuntime> {
  geminiWebSearchRuntimePromise ??= import("./gemini-web-search-provider.runtime.js");
  return geminiWebSearchRuntimePromise;
}

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
    freshness: {
      type: "string",
      description: "Limit Google Search grounding to recent results: day, week, month, or year.",
    },
    date_after: {
      type: "string",
      description: "Only ground with results published after this date (YYYY-MM-DD).",
    },
    date_before: {
      type: "string",
      description: "Only ground with results published before this date (YYYY-MM-DD).",
    },
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
    execute: async (args, context) => {
      const { executeGeminiSearch } = await loadGeminiWebSearchRuntime();
      return await executeGeminiSearch(args, searchConfig, context);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveGoogleModelProviderConfig(
  config?: OpenClawConfig,
): Record<string, unknown> | undefined {
  const provider = config?.models?.providers?.google;
  return isRecord(provider) ? provider : undefined;
}

function getGoogleModelProviderCredentialFallback(
  config?: OpenClawConfig,
): { path: string; value: unknown } | undefined {
  const provider = resolveGoogleModelProviderConfig(config);
  return provider && provider.apiKey !== undefined
    ? { path: GOOGLE_PROVIDER_CREDENTIAL_PATH, value: provider.apiKey }
    : undefined;
}

function withGoogleModelProviderFallbacks(
  searchConfig: Record<string, unknown> | undefined,
  config?: OpenClawConfig,
): Record<string, unknown> | undefined {
  const provider = resolveGoogleModelProviderConfig(config);
  if (!provider || (provider.apiKey === undefined && provider.baseUrl === undefined)) {
    return searchConfig;
  }
  const gemini = isRecord(searchConfig?.gemini) ? { ...searchConfig.gemini } : {};
  const mergedSearchConfig = searchConfig ? { ...searchConfig } : {};
  if (provider.apiKey !== undefined) {
    gemini.providerApiKey = provider.apiKey;
  }
  if (provider.baseUrl !== undefined) {
    gemini.providerBaseUrl = provider.baseUrl;
  }
  return {
    ...mergedSearchConfig,
    gemini,
  };
}

export function createGeminiWebSearchProvider(): WebSearchProviderPlugin {
  const contractFields = createWebSearchProviderContractFields({
    credentialPath: GEMINI_CREDENTIAL_PATH,
    searchCredential: { type: "scoped", scopeId: "gemini" },
    configuredCredential: { pluginId: "google" },
  });

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
    ...contractFields,
    getConfiguredCredentialFallback: getGoogleModelProviderCredentialFallback,
    createTool: (ctx) =>
      createGeminiToolDefinition(
        withGoogleModelProviderFallbacks(
          mergeScopedSearchConfig(
            ctx.searchConfig,
            "gemini",
            resolveProviderWebSearchPluginConfig(ctx.config, "google"),
          ),
          ctx.config,
        ),
      ),
  };
}

export const __testing = {
  resolveGeminiApiKey,
  resolveGeminiBaseUrl,
  resolveGeminiModel,
} as const;
