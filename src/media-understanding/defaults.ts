import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  bundledProviderSupportsNativePdfDocument,
  resolveBundledAutoMediaKeyProviders,
  resolveBundledDefaultMediaModel,
} from "./bundled-defaults.js";
import { buildMediaUnderstandingRegistry, normalizeMediaProviderId } from "./provider-registry.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";

const MB = 1024 * 1024;

export const DEFAULT_MAX_CHARS = 500;
export const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<
  MediaUnderstandingCapability,
  number | undefined
> = {
  image: DEFAULT_MAX_CHARS,
  audio: undefined,
  video: DEFAULT_MAX_CHARS,
};
export const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number> = {
  image: 10 * MB,
  audio: 20 * MB,
  video: 50 * MB,
};
export const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number> = {
  image: 60,
  audio: 60,
  video: 120,
};
export const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string> = {
  image: "Describe the image.",
  audio: "Transcribe the audio.",
  video: "Describe the video.",
};
export const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
export const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
export const DEFAULT_MEDIA_CONCURRENCY = 2;

function providerSupportsCapability(
  provider: MediaUnderstandingProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  if (!provider) {
    return false;
  }
  if (capability === "audio") {
    return Boolean(provider.transcribeAudio);
  }
  if (capability === "image") {
    return Boolean(provider.describeImage);
  }
  return Boolean(provider.describeVideo);
}

function resolveDefaultRegistry(cfg?: OpenClawConfig) {
  return buildMediaUnderstandingRegistry(undefined, cfg ?? ({} as OpenClawConfig));
}

function resolveConfiguredImageProviderModel(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const providers = params.cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  const normalizedProviderId = normalizeMediaProviderId(params.providerId);
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    if (normalizeMediaProviderId(providerKey) !== normalizedProviderId) {
      continue;
    }
    const models = providerCfg?.models ?? [];
    const match = models.find(
      (model) =>
        Boolean(normalizeOptionalString(model?.id)) &&
        Array.isArray(model?.input) &&
        model.input.includes("image"),
    );
    return normalizeOptionalString(match?.id);
  }
  return undefined;
}

export function resolveDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string | undefined {
  if (!params.providerRegistry) {
    const configuredImageModel =
      params.capability === "image"
        ? resolveConfiguredImageProviderModel({
            cfg: params.cfg,
            providerId: params.providerId,
          })
        : undefined;
    if (configuredImageModel) {
      return configuredImageModel;
    }
    const bundledDefault = resolveBundledDefaultMediaModel({
      providerId: params.providerId,
      capability: params.capability,
    });
    if (bundledDefault) {
      return bundledDefault;
    }
  }
  const registry = params.providerRegistry ?? resolveDefaultRegistry(params.cfg);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return normalizeOptionalString(provider?.defaultModels?.[params.capability]);
}

export function resolveAutoMediaKeyProviders(params: {
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[] {
  if (!params.providerRegistry) {
    const bundledProviders = resolveBundledAutoMediaKeyProviders(params.capability);
    if (params.capability !== "image") {
      return bundledProviders;
    }
    const configProviders = params.cfg?.models?.providers;
    if (!configProviders || typeof configProviders !== "object") {
      return bundledProviders;
    }
    const merged = [...bundledProviders];
    for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
      const normalizedProviderId = normalizeMediaProviderId(providerKey);
      const models = providerCfg?.models ?? [];
      const hasImageModel = models.some(
        (model) => Array.isArray(model?.input) && model.input.includes("image"),
      );
      if (hasImageModel && !merged.includes(normalizedProviderId)) {
        merged.push(normalizedProviderId);
      }
    }
    return merged;
  }
  const registry = params.providerRegistry ?? resolveDefaultRegistry(params.cfg);
  type AutoProviderEntry = {
    provider: MediaUnderstandingProvider;
    priority: number;
  };
  return [...registry.values()]
    .filter((provider) => providerSupportsCapability(provider, params.capability))
    .map((provider): AutoProviderEntry | null => {
      const priority = provider.autoPriority?.[params.capability];
      return typeof priority === "number" && Number.isFinite(priority)
        ? { provider, priority }
        : null;
    })
    .filter((entry): entry is AutoProviderEntry => entry !== null)
    .toSorted((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.provider.id.localeCompare(right.provider.id);
    })
    .map((entry) => normalizeMediaProviderId(entry.provider.id))
    .filter(Boolean);
}

export function providerSupportsNativePdfDocument(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean {
  if (!params.providerRegistry && bundledProviderSupportsNativePdfDocument(params.providerId)) {
    return true;
  }
  const registry = params.providerRegistry ?? resolveDefaultRegistry(params.cfg);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return provider?.nativeDocumentInputs?.includes("pdf") ?? false;
}

/**
 * Minimum audio file size in bytes below which transcription is skipped.
 * Files smaller than this threshold are almost certainly empty or corrupt
 * and would cause unhelpful API errors from Whisper/transcription providers.
 */
export const MIN_AUDIO_FILE_BYTES = 1024;
