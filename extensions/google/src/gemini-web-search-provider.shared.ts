import { normalizeGoogleApiBaseUrl } from "../provider-policy.js";

const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";

export type GeminiConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  providerApiKey?: unknown;
  providerBaseUrl?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveGeminiConfig(searchConfig?: Record<string, unknown>): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return isRecord(gemini) ? gemini : {};
}

export function resolveGeminiApiKey(
  gemini?: GeminiConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    trimToUndefined(gemini?.apiKey) ??
    trimToUndefined(env.GEMINI_API_KEY) ??
    trimToUndefined(gemini?.providerApiKey)
  );
}

export function resolveGeminiModel(gemini?: GeminiConfig): string {
  return trimToUndefined(gemini?.model) ?? DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}

export function resolveGeminiBaseUrl(gemini?: GeminiConfig): string {
  return normalizeGoogleApiBaseUrl(
    trimToUndefined(gemini?.baseUrl) ?? trimToUndefined(gemini?.providerBaseUrl),
  );
}
