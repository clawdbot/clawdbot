import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveEffectiveTtsConfig } from "../tts/tts-config.js";

const TTS_PROVIDER_CONFIG_RESERVED_KEYS = new Set([
  "auto",
  "enabled",
  "maxTextLength",
  "mode",
  "modelOverrides",
  "persona",
  "personas",
  "prefsPath",
  "provider",
  "providers",
  "summaryModel",
  "timeoutMs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isConfigActivationValueEnabled(value: unknown): boolean {
  if (value === false) {
    return false;
  }
  if (isRecord(value) && value.enabled === false) {
    return false;
  }
  return true;
}

export function normalizeConfiguredSpeechProviderIdForStartup(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function resolveProviderConfigActivation(
  ttsConfig: Record<string, unknown>,
  providerId: string,
): boolean | undefined {
  let fromProviders: boolean | undefined;
  if (isRecord(ttsConfig.providers)) {
    for (const [key, providerConfig] of Object.entries(ttsConfig.providers)) {
      if (normalizeConfiguredSpeechProviderIdForStartup(key) === providerId) {
        fromProviders = isConfigActivationValueEnabled(providerConfig);
      }
    }
  }
  if (fromProviders !== undefined) {
    return fromProviders;
  }

  for (const [key, providerConfig] of Object.entries(ttsConfig)) {
    if (TTS_PROVIDER_CONFIG_RESERVED_KEYS.has(key) || !isRecord(providerConfig)) {
      continue;
    }
    if (normalizeConfiguredSpeechProviderIdForStartup(key) === providerId) {
      return isConfigActivationValueEnabled(providerConfig);
    }
  }
  return undefined;
}

function addProviderIfEnabled(
  target: Set<string>,
  ttsConfig: Record<string, unknown>,
  providerId: unknown,
): void {
  const normalized = normalizeConfiguredSpeechProviderIdForStartup(providerId);
  if (!normalized) {
    return;
  }
  if (resolveProviderConfigActivation(ttsConfig, normalized) !== false) {
    target.add(normalized);
  }
}

function findActivePersona(
  ttsConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const personaId = normalizeOptionalLowercaseString(
    typeof ttsConfig.persona === "string" ? ttsConfig.persona : undefined,
  );
  if (!personaId || !isRecord(ttsConfig.personas)) {
    return undefined;
  }
  for (const [id, persona] of Object.entries(ttsConfig.personas)) {
    if (normalizeOptionalLowercaseString(id) === personaId && isRecord(persona)) {
      return persona;
    }
  }
  return undefined;
}

function addActivePersonaProvider(target: Set<string>, ttsConfig: Record<string, unknown>): void {
  const persona = findActivePersona(ttsConfig);
  if (!persona) {
    return;
  }
  const provider = normalizeConfiguredSpeechProviderIdForStartup(persona.provider);
  if (!provider) {
    return;
  }
  const rootActivation = resolveProviderConfigActivation(ttsConfig, provider);
  const personaActivation = resolveProviderConfigActivation(persona, provider);
  if ((personaActivation ?? rootActivation) !== false) {
    target.add(provider);
  }
}

function addConfiguredTtsProviderIds(target: Set<string>, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  addProviderIfEnabled(target, value, value.provider);
  addActivePersonaProvider(target, value);

  if (isRecord(value.providers)) {
    for (const [providerId, providerConfig] of Object.entries(value.providers)) {
      if (isConfigActivationValueEnabled(providerConfig)) {
        addProviderIfEnabled(target, value, providerId);
      }
    }
  }
  for (const [key, providerConfig] of Object.entries(value)) {
    if (TTS_PROVIDER_CONFIG_RESERVED_KEYS.has(key) || !isRecord(providerConfig)) {
      continue;
    }
    if (isConfigActivationValueEnabled(providerConfig)) {
      addProviderIfEnabled(target, value, key);
    }
  }
}

export function collectConfiguredSpeechProviderIds(config: OpenClawConfig): ReadonlySet<string> {
  const configured = new Set<string>();
  addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config));

  const agents = config.agents;
  if (isRecord(agents) && Array.isArray(agents.list)) {
    for (const agent of agents.list) {
      if (isRecord(agent)) {
        if (typeof agent.id === "string") {
          addConfiguredTtsProviderIds(
            configured,
            resolveEffectiveTtsConfig(config, { agentId: agent.id }),
          );
        } else {
          addConfiguredTtsProviderIds(configured, agent.tts);
        }
      }
    }
  }

  const channels = config.channels;
  if (isRecord(channels)) {
    for (const [channelId, channelConfig] of Object.entries(channels)) {
      if (!isRecord(channelConfig)) {
        continue;
      }
      addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config, { channelId }));
      if (isRecord(channelConfig.voice)) {
        addConfiguredTtsProviderIds(configured, channelConfig.voice.tts);
      }
      if (isRecord(channelConfig.accounts)) {
        for (const [accountId, accountConfig] of Object.entries(channelConfig.accounts)) {
          if (!isRecord(accountConfig)) {
            continue;
          }
          addConfiguredTtsProviderIds(
            configured,
            resolveEffectiveTtsConfig(config, { channelId, accountId }),
          );
          if (isRecord(accountConfig.voice)) {
            addConfiguredTtsProviderIds(configured, accountConfig.voice.tts);
          }
        }
      }
    }
  }

  const pluginEntries = config.plugins?.entries;
  if (isRecord(pluginEntries)) {
    for (const entry of Object.values(pluginEntries)) {
      if (isRecord(entry) && isRecord(entry.config)) {
        addConfiguredTtsProviderIds(configured, entry.config.tts);
      }
    }
  }

  return configured;
}
