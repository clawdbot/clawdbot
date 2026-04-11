import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { MusicGenerationProviderPlugin } from "../plugins/types.js";

const BUILTIN_MUSIC_GENERATION_PROVIDERS: readonly MusicGenerationProviderPlugin[] = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeMusicGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeMusicGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}

function resolvePluginMusicGenerationProviders(
  cfg?: OpenClawConfig,
): MusicGenerationProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "musicGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, MusicGenerationProviderPlugin>;
  aliases: Map<string, MusicGenerationProviderPlugin>;
} {
  const canonical = new Map<string, MusicGenerationProviderPlugin>();
  const aliases = new Map<string, MusicGenerationProviderPlugin>();
  const register = (provider: MusicGenerationProviderPlugin) => {
    const id = normalizeMusicGenerationProviderId(provider.id);
    if (!isSafeMusicGenerationProviderId(id)) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeMusicGenerationProviderId(alias);
      if (isSafeMusicGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of BUILTIN_MUSIC_GENERATION_PROVIDERS) {
    register(provider);
  }
  for (const provider of resolvePluginMusicGenerationProviders(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
}

export function listMusicGenerationProviders(
  cfg?: OpenClawConfig,
): MusicGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getMusicGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): MusicGenerationProviderPlugin | undefined {
  const normalized = normalizeMusicGenerationProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
