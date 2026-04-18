export const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
export const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";

const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

export type PerplexityTransport = "search_api" | "chat_completions";
export type PerplexityBaseUrlHint = "direct" | "openrouter";
export type PerplexityRuntimeTransportContext = {
  searchConfig?: Record<string, unknown>;
  resolvedKey?: string;
  keySource: "config" | "secretRef" | "env" | "missing";
  fallbackEnvVar?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return trimToUndefined(value)?.toLowerCase() ?? "";
}

export function inferPerplexityBaseUrlFromApiKey(
  apiKey?: string,
): PerplexityBaseUrlHint | undefined {
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

export function resolvePerplexityRuntimeTransport(
  params: PerplexityRuntimeTransportContext,
): PerplexityTransport | undefined {
  const perplexity = params.searchConfig?.perplexity;
  const scoped =
    perplexity && typeof perplexity === "object" && !Array.isArray(perplexity)
      ? (perplexity as { baseUrl?: string; model?: string })
      : undefined;
  const configuredBaseUrl = trimToUndefined(scoped?.baseUrl) ?? "";
  const configuredModel = trimToUndefined(scoped?.model) ?? "";
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
