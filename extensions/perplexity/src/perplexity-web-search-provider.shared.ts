import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
export const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";

const PERPLEXITY_CREDENTIAL_PATH = "plugins.entries.perplexity.config.webSearch.apiKey";
const PERPLEXITY_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

export type PerplexityTransport = "search_api" | "chat_completions";
type PerplexityRuntimeTransportContext = {
  searchConfig?: Record<string, unknown>;
  resolvedKey?: string;
  keySource: "config" | "secretRef" | "env" | "missing";
  fallbackEnvVar?: string;
};

export function createPerplexityWebSearchProviderBase() {
  return {
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Requires Perplexity API key or OpenRouter API key · structured results",
    onboardingScopes: [...PERPLEXITY_ONBOARDING_SCOPES],
    credentialLabel: "Perplexity API key",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    docsUrl: "https://docs.openclaw.ai/perplexity",
    autoDetectOrder: 50,
    credentialPath: PERPLEXITY_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: PERPLEXITY_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "perplexity" },
      configuredCredential: { pluginId: "perplexity" },
    }),
  };
}

export function resolvePerplexityWebSearchRuntimeMetadata(
  ctx: Parameters<NonNullable<WebSearchProviderPlugin["resolveRuntimeMetadata"]>>[0],
) {
  return {
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
  };
}

export function inferPerplexityBaseUrlFromApiKey(
  apiKey?: string,
): "direct" | "openrouter" | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(apiKey);
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

export function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  try {
    return (
      normalizeLowercaseStringOrEmpty(new URL(baseUrl.trim()).hostname) === "api.perplexity.ai"
    );
  } catch {
    return false;
  }
}

function resolvePerplexityRuntimeTransport(
  params: PerplexityRuntimeTransportContext,
): PerplexityTransport | undefined {
  const perplexity = params.searchConfig?.perplexity;
  const scoped =
    perplexity && typeof perplexity === "object" && !Array.isArray(perplexity)
      ? (perplexity as { baseUrl?: string; model?: string })
      : undefined;
  const configuredBaseUrl = normalizeOptionalString(scoped?.baseUrl) ?? "";
  const configuredModel = normalizeOptionalString(scoped?.model) ?? "";
  const baseUrl = (() => {
    if (configuredBaseUrl) {
      return configuredBaseUrl;
    }
    if (params.keySource === "env") {
      if (params.fallbackEnvVar === "PERPLEXITY_API_KEY") {
        return PERPLEXITY_DIRECT_BASE_URL;
      }
      if (params.fallbackEnvVar === "OPENROUTER_API_KEY") {
        return DEFAULT_PERPLEXITY_BASE_URL;
      }
    }
    if ((params.keySource === "config" || params.keySource === "secretRef") && params.resolvedKey) {
      return inferPerplexityBaseUrlFromApiKey(params.resolvedKey) === "openrouter"
        ? DEFAULT_PERPLEXITY_BASE_URL
        : PERPLEXITY_DIRECT_BASE_URL;
    }
    return DEFAULT_PERPLEXITY_BASE_URL;
  })();
  return configuredBaseUrl || configuredModel || !isDirectPerplexityBaseUrl(baseUrl)
    ? "chat_completions"
    : "search_api";
}
