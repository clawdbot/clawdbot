// Perplexity provider module implements model/runtime integration.
import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";

const PERPLEXITY_CREDENTIAL_PATH = "plugins.entries.perplexity.config.webSearch.apiKey";
const PERPLEXITY_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

export type PerplexityTransport = "search_api" | "chat_completions";
export type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};
export type PerplexityAuth = {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
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
  const credential = ctx.resolvedCredential;
  // Resolved SecretRefs use configured-key inference; env fallbacks own their endpoint.
  const source: PerplexityAuth["source"] =
    credential?.source === "env"
      ? credential.fallbackEnvVar === "PERPLEXITY_API_KEY"
        ? "perplexity_env"
        : "openrouter_env"
      : (credential?.source === "config" || credential?.source === "secretRef") && credential.value
        ? "config"
        : "none";
  return {
    perplexityTransport: resolvePerplexityRuntime(
      resolvePerplexityConfig(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "perplexity",
          resolveProviderWebSearchPluginConfig(ctx.config, "perplexity"),
        ),
      ),
      { apiKey: credential?.value, source },
    ).transport,
  };
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): "direct" | "openrouter" | undefined {
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

export function resolvePerplexityConfig(searchConfig?: Record<string, unknown>): PerplexityConfig {
  const perplexity = searchConfig?.perplexity;
  return isRecord(perplexity) ? (perplexity as PerplexityConfig) : {};
}

export function hasPerplexityLegacyOverride(perplexity?: PerplexityConfig): boolean {
  return Boolean(
    normalizeOptionalString(perplexity?.baseUrl) || normalizeOptionalString(perplexity?.model),
  );
}

export function resolvePerplexityRuntime(
  perplexity: PerplexityConfig | undefined,
  auth: PerplexityAuth,
): PerplexityAuth & { baseUrl: string; model: string; transport: PerplexityTransport } {
  const baseUrl =
    normalizeOptionalString(perplexity?.baseUrl) ||
    (auth.source === "perplexity_env" ||
    (auth.source === "config" && inferPerplexityBaseUrlFromApiKey(auth.apiKey) !== "openrouter")
      ? PERPLEXITY_DIRECT_BASE_URL
      : DEFAULT_PERPLEXITY_BASE_URL);
  return {
    apiKey: auth.apiKey,
    source: auth.source,
    baseUrl,
    model: normalizeOptionalString(perplexity?.model) || DEFAULT_PERPLEXITY_MODEL,
    transport:
      hasPerplexityLegacyOverride(perplexity) || !isDirectPerplexityBaseUrl(baseUrl)
        ? "chat_completions"
        : "search_api",
  };
}
