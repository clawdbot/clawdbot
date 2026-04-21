import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";

type OllamaProviderConfigDraft = Partial<ModelProviderConfig>;

/**
 * Provider policy surface for Ollama: normalize provider configs used by
 * core defaults/normalizers. This runs during config defaults application and
 * normalization paths (not Zod validation).
 */
export function normalizeConfig({
  provider,
  providerConfig,
}: {
  provider: string;
  providerConfig: OllamaProviderConfigDraft;
}): OllamaProviderConfigDraft {
  if (!providerConfig || typeof providerConfig !== "object") {
    return providerConfig;
  }

  const normalizedProviderId = (provider ?? "").trim().toLowerCase();
  if (normalizedProviderId !== "ollama") {
    return providerConfig;
  }

  const next: OllamaProviderConfigDraft = { ...providerConfig };

  // If baseUrl is missing, empty, or whitespace-only, default to local Ollama host.
  if (typeof next.baseUrl !== "string" || !next.baseUrl.trim()) {
    next.baseUrl = OLLAMA_DEFAULT_BASE_URL;
  }

  // If models is missing/not an array, default to empty array to signal discovery.
  if (!Array.isArray(next.models)) {
    next.models = [];
  }

  return next;
}
