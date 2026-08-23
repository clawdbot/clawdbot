// Ollama API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderNormalizeResolvedModelContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { isCloudModelRef, normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { OLLAMA_CLOUD_PROVIDER_ID, OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";
import { supportsOllamaCloudFullThinkingEffort } from "./src/model-reasoning.js";

type OllamaProviderConfigDraft = Partial<ModelProviderConfig>;

const OLLAMA_REASONING_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

const OLLAMA_NON_REASONING_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

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

/**
 * Ollama's local and cloud providers do not normalize resolved models.
 * Skip full plugin activation when the model-list path asks for that no-op.
 */
export function projectConfiguredModelRow(ctx: ProviderNormalizeResolvedModelContext) {
  const provider = ctx.provider.trim().toLowerCase();
  return provider === "ollama" || provider === OLLAMA_CLOUD_PROVIDER_ID ? null : undefined;
}

export function resolveThinkingProfile({
  modelId,
  provider,
  reasoning,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  const isCloudRoute =
    normalizeProviderId(provider) === OLLAMA_CLOUD_PROVIDER_ID || isCloudModelRef(modelId);
  const supportsThinking =
    reasoning === true ||
    (reasoning === undefined && isCloudRoute && supportsOllamaCloudFullThinkingEffort(modelId));
  return supportsThinking
    ? OLLAMA_REASONING_THINKING_PROFILE
    : OLLAMA_NON_REASONING_THINKING_PROFILE;
}
