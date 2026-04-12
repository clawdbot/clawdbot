import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import type {
  ResolvedTalkConfig,
  TalkConfig,
  TalkConfigResponse,
  TalkProviderConfig,
} from "./types.gateway.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { coerceSecretRef } from "./types.secrets.js";

function normalizeTalkSecretInput(value: unknown): TalkProviderConfig["apiKey"] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return coerceSecretRef(value) ?? undefined;
}

function normalizeSilenceTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function buildLegacyTalkProviderCompat(
  value: Record<string, unknown>,
): TalkProviderConfig | undefined {
  const provider: TalkProviderConfig = {};
  for (const key of ["voiceId", "voiceAliases", "modelId", "outputFormat"] as const) {
    if (value[key] !== undefined) {
      provider[key] = value[key];
    }
  }
  const apiKey = normalizeTalkSecretInput(value.apiKey);
  if (apiKey !== undefined) {
    provider.apiKey = apiKey;
  }
  return Object.keys(provider).length > 0 ? provider : undefined;
}

function normalizeTalkProviderConfig(value: unknown): TalkProviderConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const provider: TalkProviderConfig = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) {
      continue;
    }
    if (key === "apiKey") {
      const normalized = normalizeTalkSecretInput(raw);
      if (normalized !== undefined) {
        provider.apiKey = normalized;
      }
      continue;
    }
    provider[key] = raw;
  }

  return Object.keys(provider).length > 0 ? provider : undefined;
}

function normalizeTalkProviders(value: unknown): Record<string, TalkProviderConfig> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers: Record<string, TalkProviderConfig> = {};
  for (const [rawProviderId, providerConfig] of Object.entries(value)) {
    const providerId = normalizeOptionalString(rawProviderId);
    if (!providerId) {
      continue;
    }
    const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
    if (!normalizedProvider) {
      continue;
    }
    providers[providerId] = {
      ...providers[providerId],
      ...normalizedProvider,
    };
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function activeProviderFromTalk(talk: TalkConfig): string | undefined {
  const provider = normalizeOptionalString(talk.provider);
  const providers = talk.providers;
  if (provider) {
    if (providers && !(provider in providers)) {
      return undefined;
    }
    return provider;
  }
  const providerIds = providers ? Object.keys(providers) : [];
  return providerIds.length === 1 ? providerIds[0] : undefined;
}

export function normalizeTalkSection(value: TalkConfig | undefined): TalkConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const normalized: TalkConfig = {};
  if (typeof source.interruptOnSpeech === "boolean") {
    normalized.interruptOnSpeech = source.interruptOnSpeech;
  }
  const silenceTimeoutMs = normalizeSilenceTimeoutMs(source.silenceTimeoutMs);
  if (silenceTimeoutMs !== undefined) {
    normalized.silenceTimeoutMs = silenceTimeoutMs;
  }

  const providers = normalizeTalkProviders(source.providers);
  const provider = normalizeOptionalString(source.provider);
  if (providers) {
    normalized.providers = providers;
  }
  if (provider) {
    normalized.provider = provider;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeTalkConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.talk) {
    return config;
  }
  const normalizedTalk = normalizeTalkSection(config.talk);
  if (!normalizedTalk) {
    return config;
  }
  return {
    ...config,
    talk: normalizedTalk,
  };
}

export function resolveActiveTalkProviderConfig(
  talk: TalkConfig | undefined,
): ResolvedTalkConfig | undefined {
  const normalizedTalk = normalizeTalkSection(talk);
  if (!normalizedTalk) {
    return undefined;
  }
  const provider = activeProviderFromTalk(normalizedTalk);
  if (!provider) {
    return undefined;
  }
  return {
    provider,
    config: normalizedTalk.providers?.[provider] ?? {},
  };
}

export function buildTalkConfigResponse(value: unknown): TalkConfigResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeTalkSection(value as TalkConfig);
  const legacyCompat = buildLegacyTalkProviderCompat(value);
  if (!normalized && !legacyCompat) {
    return undefined;
  }

  const payload: TalkConfigResponse = {};
  if (typeof normalized?.interruptOnSpeech === "boolean") {
    payload.interruptOnSpeech = normalized.interruptOnSpeech;
  }
  if (typeof normalized?.silenceTimeoutMs === "number") {
    payload.silenceTimeoutMs = normalized.silenceTimeoutMs;
  }
  if (normalized?.providers && Object.keys(normalized.providers).length > 0) {
    payload.providers = normalized.providers;
  }

  const resolved =
    resolveActiveTalkProviderConfig(normalized) ??
    (legacyCompat ? { provider: "elevenlabs", config: legacyCompat } : undefined);
  const activeProvider = normalizeOptionalString(normalized?.provider) ?? resolved?.provider;
  if (activeProvider) {
    payload.provider = activeProvider;
  }
  if (resolved) {
    payload.resolved = resolved;
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}
