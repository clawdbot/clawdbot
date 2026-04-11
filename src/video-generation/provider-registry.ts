import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

const BUILTIN_VIDEO_GENERATION_PROVIDERS: readonly VideoGenerationProviderPlugin[] = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeVideoGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeVideoGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}

function resolvePluginVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "videoGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, VideoGenerationProviderPlugin>;
  aliases: Map<string, VideoGenerationProviderPlugin>;
} {
  const canonical = new Map<string, VideoGenerationProviderPlugin>();
  const aliases = new Map<string, VideoGenerationProviderPlugin>();
  const register = (provider: VideoGenerationProviderPlugin) => {
    const id = normalizeVideoGenerationProviderId(provider.id);
    if (!isSafeVideoGenerationProviderId(id)) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeVideoGenerationProviderId(alias);
      if (isSafeVideoGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of BUILTIN_VIDEO_GENERATION_PROVIDERS) {
    register(provider);
  }
  for (const provider of resolvePluginVideoGenerationProviders(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
}

export function listVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getVideoGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin | undefined {
  const normalized = normalizeVideoGenerationProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
