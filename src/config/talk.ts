// Normalizes talk-mode config for voice and channel interactions.
import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import { isRecord } from "../utils.js";
import type {
  ResolvedTalkConfig,
  TalkConfig,
  TalkConfigResponse,
  TalkProviderConfig,
  TalkRealtimeConfig,
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

function normalizeTalkRealtimeConfig(value: unknown): TalkRealtimeConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = value;
  const normalized: TalkRealtimeConfig = {};

  const provider = normalizeOptionalString(source.provider);
  if (provider) {
    normalized.provider = provider;
  }
  const providers = normalizeTalkProviders(source.providers);
  if (providers) {
    normalized.providers = providers;
  }
  const model = normalizeOptionalString(source.model);
  if (model) {
    normalized.model = model;
  }
  const voice = normalizeOptionalString(source.voice);
  const speakerVoice = normalizeOptionalString(source.speakerVoice) ?? voice;
  const speakerVoiceId = normalizeOptionalString(source.speakerVoiceId);
  if (speakerVoice) {
    normalized.speakerVoice = speakerVoice;
  }
  if (speakerVoiceId) {
    normalized.speakerVoiceId = speakerVoiceId;
  }
  if (voice) {
    normalized.voice = voice;
  }
  const instructions = normalizeOptionalString(source.instructions);
  if (instructions) {
    normalized.instructions = instructions;
  }
  if (source.mode === "realtime" || source.mode === "stt-tts" || source.mode === "transcription") {
    normalized.mode = source.mode;
  }
  if (
    source.transport === "webrtc" ||
    source.transport === "provider-websocket" ||
    source.transport === "gateway-relay" ||
    source.transport === "managed-room"
  ) {
    normalized.transport = source.transport;
  }
  if (
    source.brain === "agent-consult" ||
    source.brain === "direct-tools" ||
    source.brain === "none"
  ) {
    normalized.brain = source.brain;
  }
  if (
    source.consultRouting === "provider-direct" ||
    source.consultRouting === "force-agent-consult"
  ) {
    normalized.consultRouting = source.consultRouting;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
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

/**
 * Normalize persisted Talk config into the canonical provider/providers shape.
 * Legacy flat provider fields are ignored here so core config stays provider-agnostic.
 */
export function normalizeTalkSection(value: TalkConfig | undefined): TalkConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const normalized: TalkConfig = {};
  const speechLocale = normalizeOptionalString(source.speechLocale);
  if (speechLocale) {
    normalized.speechLocale = speechLocale;
  }
  if (typeof source.interruptOnSpeech === "boolean") {
    normalized.interruptOnSpeech = source.interruptOnSpeech;
  }
  const consultThinkingLevel = normalizeThinkLevel(
    normalizeOptionalString(source.consultThinkingLevel),
  );
  if (consultThinkingLevel) {
    normalized.consultThinkingLevel = consultThinkingLevel;
  }
  const rawConsultFastMode = source.consultFastMode;
  const consultFastMode =
    typeof rawConsultFastMode === "boolean" || typeof rawConsultFastMode === "string"
      ? normalizeFastMode(rawConsultFastMode)
      : undefined;
  if (consultFastMode !== undefined) {
    normalized.consultFastMode = consultFastMode;
  }
  const silenceTimeoutMs = normalizeSilenceTimeoutMs(source.silenceTimeoutMs);
  if (silenceTimeoutMs !== undefined) {
    normalized.silenceTimeoutMs = silenceTimeoutMs;
  }

  const providers = normalizeTalkProviders(source.providers);
  const realtime = normalizeTalkRealtimeConfig(source.realtime);
  const provider = normalizeOptionalString(source.provider);
  if (providers) {
    normalized.providers = providers;
  }
  if (realtime) {
    normalized.realtime = realtime;
  }
  if (provider) {
    normalized.provider = provider;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Return a config copy with `talk` normalized when a valid Talk section is present. */
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

/**
 * Resolve the single active Talk speech provider and its provider-owned config.
 * Ambiguous multi-provider config stays unresolved until `talk.provider` names one.
 */
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

/**
 * Build the gateway `talk.config` payload from persisted config.
 * The response includes canonical provider data plus the resolved provider when selection is unambiguous.
 */
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
  if (typeof normalized?.consultThinkingLevel === "string") {
    payload.consultThinkingLevel = normalized.consultThinkingLevel;
  }
  if (typeof normalized?.consultFastMode === "boolean") {
    payload.consultFastMode = normalized.consultFastMode;
  }
  if (typeof normalized?.speechLocale === "string") {
    payload.speechLocale = normalized.speechLocale;
  }
  if (normalized?.providers && Object.keys(normalized.providers).length > 0) {
    payload.providers = normalized.providers;
  }
  if (normalized?.realtime && Object.keys(normalized.realtime).length > 0) {
    payload.realtime = normalized.realtime;
  }

  // Keep legacy flat ElevenLabs fields readable for clients while migration moves writes to
  // talk.provider/providers; normalizeTalkSection intentionally excludes those provider details.
  const resolved =
    resolveActiveTalkProviderConfig(normalized) ??
    (legacyCompat ? { provider: "elevenlabs", config: legacyCompat } : undefined);
  const activeProvider = resolved?.provider;
  if (activeProvider) {
    payload.provider = activeProvider;
  }
  if (resolved) {
    payload.resolved = resolved;
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}
