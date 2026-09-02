// Openzoo provider module implements model/runtime integration.
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OPENZOO_LOCAL_API_KEY_PLACEHOLDER } from "./provider-models.js";

export function hasOpenzooAuthorizationHeader(headers: unknown): boolean {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return false;
  }
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.trim().toLowerCase() !== "authorization") {
      continue;
    }
    if (hasConfiguredSecretInput(headerValue)) {
      return true;
    }
  }
  return false;
}

/** Returns `api-key` only for a real operator credential, never for the keyless markers. */
export function resolveOpenzooProviderAuthMode(
  apiKey: ModelProviderConfig["apiKey"] | undefined,
): ModelProviderConfig["auth"] | undefined {
  const normalized = normalizeOptionalSecretInput(apiKey);
  if (normalized !== undefined) {
    const trimmed = normalized.trim();
    if (
      !trimmed ||
      trimmed === OPENZOO_LOCAL_API_KEY_PLACEHOLDER ||
      trimmed === CUSTOM_LOCAL_AUTH_MARKER
    ) {
      return undefined;
    }
    return "api-key";
  }
  return hasConfiguredSecretInput(apiKey) ? "api-key" : undefined;
}

export function isOpenzooKeylessApiKey(apiKey: string | undefined): boolean {
  const trimmed = apiKey?.trim();
  return trimmed === OPENZOO_LOCAL_API_KEY_PLACEHOLDER || trimmed === CUSTOM_LOCAL_AUTH_MARKER;
}

export function shouldUseOpenzooSyntheticAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  const hasModels = Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
  return (
    hasModels &&
    !resolveOpenzooProviderAuthMode(providerConfig?.apiKey) &&
    !hasOpenzooAuthorizationHeader(providerConfig?.headers)
  );
}
