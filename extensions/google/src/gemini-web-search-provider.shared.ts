// Google provider module implements model/runtime integration.
import {
  isRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeGoogleApiBaseUrl } from "./google-api-base-url.js";

const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-flash-latest";

export type GeminiConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  providerApiKey?: unknown;
  providerBaseUrl?: unknown;
};

export function resolveGeminiConfig(searchConfig?: Record<string, unknown>): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return isRecord(gemini) ? gemini : {};
}

export function resolveGeminiModel(gemini?: GeminiConfig): string {
  return trimToUndefined(gemini?.model) ?? DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}

export function resolveGeminiBaseUrl(gemini?: GeminiConfig): string {
  return normalizeGoogleApiBaseUrl(
    trimToUndefined(gemini?.baseUrl) ?? trimToUndefined(gemini?.providerBaseUrl),
  );
}
