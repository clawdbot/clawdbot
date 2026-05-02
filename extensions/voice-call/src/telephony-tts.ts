import {
  parseTtsDirectives,
  type SpeechModelOverridePolicy,
  type SpeechProviderConfig,
  type TtsDirectiveOverrides,
} from "openclaw/plugin-sdk/speech";
import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { deepMergeDefined } from "./deep-merge.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

export type TelephonyTtsRuntime = {
  textToSpeechTelephony: (params: {
    text: string;
    cfg: CoreConfig;
    prefsPath?: string;
    overrides?: TtsDirectiveOverrides;
  }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    fallbackFrom?: string;
    attemptedProviders?: string[];
    error?: string;
  }>;
};

export type TelephonyTtsProvider = {
  synthesisTimeoutMs: number;
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
};

export const TELEPHONY_DEFAULT_TTS_TIMEOUT_MS = 8000;

type TelephonyModelOverrideConfig = {
  enabled?: boolean;
  allowText?: boolean;
  allowProvider?: boolean;
  allowVoice?: boolean;
  allowModelId?: boolean;
  allowVoiceSettings?: boolean;
  allowNormalization?: boolean;
  allowSeed?: boolean;
};

export function createTelephonyTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
  logger?: {
    warn?: (message: string) => void;
  };
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime, logger } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);
  const ttsConfig = mergedConfig.messages?.tts;
  const modelOverrides = resolveTelephonyModelOverridePolicy(
    readTelephonyModelOverrides(ttsConfig),
  );
  const providerConfigs = collectTelephonyProviderConfigs(ttsConfig);
  const activeProvider = normalizeProviderId(ttsConfig?.provider);
  const synthesisTimeoutMs =
    mergedConfig.messages?.tts?.timeoutMs ?? TELEPHONY_DEFAULT_TTS_TIMEOUT_MS;

  return {
    synthesisTimeoutMs,
    synthesizeForTelephony: async (text: string) => {
      const directives = parseTtsDirectives(text, modelOverrides, {
        cfg: mergedConfig,
        providerConfigs,
        preferredProviderId: activeProvider,
      });
      if (directives.warnings.length > 0) {
        logger?.warn?.(
          `[voice-call] Ignored telephony TTS directive overrides (${directives.warnings.join("; ")})`,
        );
      }
      const cleanText = directives.hasDirective
        ? directives.ttsText?.trim() || directives.cleanedText.trim()
        : text;
      const result = await runtime.textToSpeechTelephony({
        text: cleanText,
        cfg: mergedConfig,
        overrides: directives.overrides,
      });

      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }

      if (result.fallbackFrom && result.provider && result.fallbackFrom !== result.provider) {
        const attemptedChain =
          result.attemptedProviders && result.attemptedProviders.length > 0
            ? result.attemptedProviders.join(" -> ")
            : `${result.fallbackFrom} -> ${result.provider}`;
        logger?.warn?.(
          `[voice-call] Telephony TTS fallback used from=${result.fallbackFrom} to=${result.provider} attempts=${attemptedChain}`,
        );
      }

      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    },
  };
}

function applyTtsOverride(coreConfig: CoreConfig, override?: VoiceCallTtsConfig): CoreConfig {
  if (!override) {
    return coreConfig;
  }

  const base = coreConfig.messages?.tts;
  const merged = mergeTtsConfig(base, override);
  if (!merged) {
    return coreConfig;
  }

  return {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: merged,
    },
  };
}

function mergeTtsConfig(
  base?: VoiceCallTtsConfig,
  override?: VoiceCallTtsConfig,
): VoiceCallTtsConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!override) {
    return base;
  }
  if (!base) {
    return override;
  }
  return deepMergeDefined(base, override) as VoiceCallTtsConfig;
}

function resolveTelephonyModelOverridePolicy(
  overrides: TelephonyModelOverrideConfig | undefined,
): SpeechModelOverridePolicy {
  const enabled = overrides?.enabled ?? true;
  if (!enabled) {
    return {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };
  }
  const allow = (value: boolean | undefined, defaultValue = true) => value ?? defaultValue;
  return {
    enabled: true,
    allowText: allow(overrides?.allowText),
    allowProvider: allow(overrides?.allowProvider, false),
    allowVoice: allow(overrides?.allowVoice),
    allowModelId: allow(overrides?.allowModelId),
    allowVoiceSettings: allow(overrides?.allowVoiceSettings),
    allowNormalization: allow(overrides?.allowNormalization),
    allowSeed: allow(overrides?.allowSeed),
  };
}

function readTelephonyModelOverrides(
  ttsConfig: VoiceCallTtsConfig | undefined,
): TelephonyModelOverrideConfig | undefined {
  const value = (ttsConfig as Record<string, unknown> | undefined)?.modelOverrides;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TelephonyModelOverrideConfig)
    : undefined;
}

function normalizeProviderId(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined;
}

function asProviderConfig(value: unknown): SpeechProviderConfig {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SpeechProviderConfig)
    : {};
}

function collectTelephonyProviderConfigs(
  ttsConfig: VoiceCallTtsConfig | undefined,
): Record<string, SpeechProviderConfig> {
  if (!ttsConfig) {
    return {};
  }
  const entries: Record<string, SpeechProviderConfig> = {};
  const rawProviders =
    ttsConfig.providers &&
    typeof ttsConfig.providers === "object" &&
    !Array.isArray(ttsConfig.providers)
      ? (ttsConfig.providers as Record<string, unknown>)
      : {};
  for (const [providerId, value] of Object.entries(rawProviders)) {
    const normalized = normalizeProviderId(providerId) ?? providerId;
    entries[normalized] = asProviderConfig(value);
  }
  const reservedKeys = new Set([
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
  for (const [key, value] of Object.entries(ttsConfig as Record<string, unknown>)) {
    if (
      reservedKeys.has(key) ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      continue;
    }
    const normalized = normalizeProviderId(key) ?? key;
    entries[normalized] ??= asProviderConfig(value);
  }
  return entries;
}
