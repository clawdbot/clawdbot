import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { buildMediaUnderstandingManifestMetadataRegistry } from "./manifest-metadata.js";
import { normalizeMediaProviderId } from "./provider-registry.js";
import { providerSupportsCapability } from "./provider-supports.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";
export {
  CLI_OUTPUT_MAX_BUFFER,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_CHARS_BY_CAPABILITY,
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_VIDEO_MAX_BASE64_BYTES,
  MIN_AUDIO_FILE_BYTES,
} from "./defaults.constants.js";

let defaultRegistryCache: Map<string, MediaUnderstandingProvider> | null = null;
const configRegistryCache = new Map<string, Map<string, MediaUnderstandingProvider>>();
const MAX_CONFIG_REGISTRY_CACHE_ENTRIES = 32;

function cacheConfigRegistry(
  key: string,
  registry: Map<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  if (
    !configRegistryCache.has(key) &&
    configRegistryCache.size >= MAX_CONFIG_REGISTRY_CACHE_ENTRIES
  ) {
    const oldestKey = configRegistryCache.keys().next().value;
    if (oldestKey) {
      configRegistryCache.delete(oldestKey);
    }
  }
  configRegistryCache.set(key, registry);
  return registry;
}

function resolveDefaultRegistry(cfg?: OpenClawConfig, workspaceDir?: string) {
  if (!cfg) {
    defaultRegistryCache ??= buildMediaUnderstandingManifestMetadataRegistry();
    return defaultRegistryCache;
  }
  const cacheKey = `${resolveRuntimeConfigCacheKey(cfg)}:${workspaceDir ?? ""}`;
  const cached = configRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const registry = buildMediaUnderstandingManifestMetadataRegistry(cfg, workspaceDir);
  return cacheConfigRegistry(cacheKey, registry);
}

function providerHasDeclaredCapability(
  provider: MediaUnderstandingProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  return (
    provider?.capabilities?.includes(capability) ?? providerSupportsCapability(provider, capability)
  );
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

function resolveConfiguredImageProviderIds(cfg?: OpenClawConfig): string[] {
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const configured: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    const normalizedProviderId = normalizeMediaProviderId(providerKey);
    if (!normalizedProviderId || configured.includes(normalizedProviderId)) {
      continue;
    }
    const models = providerCfg?.models ?? [];
    const hasImageModel = models.some(
      (model) => Array.isArray(model?.input) && model.input.includes("image"),
    );
    if (hasImageModel) {
      configured.push(normalizedProviderId);
    }
  }
  return configured;
}

export function resolveDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
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
  }
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return normalizeOptionalString(provider?.defaultModels?.[params.capability]);
}

export function resolveAutoMediaKeyProviders(params: {
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[] {
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  type AutoProviderEntry = {
    provider: MediaUnderstandingProvider;
    priority: number;
  };
  const prioritized = [...registry.values()]
    .filter((provider) => providerHasDeclaredCapability(provider, params.capability))
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
  if (params.providerRegistry || params.capability !== "image") {
    return prioritized;
  }
  return [...new Set([...prioritized, ...resolveConfiguredImageProviderIds(params.cfg)])];
}

export function providerSupportsNativePdfDocument(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean {
  const registry =
    params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir);
  const provider = registry.get(normalizeMediaProviderId(params.providerId));
  return provider?.nativeDocumentInputs?.includes("pdf") ?? false;
}
