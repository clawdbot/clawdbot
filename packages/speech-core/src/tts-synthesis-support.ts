import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsProvider,
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  type SpeechProviderConfig,
  type SpeechProviderOverrides,
} from "openclaw/plugin-sdk/speech-core";
import type { VoiceModelRef, VoiceProviderCandidate } from "../voice-models.js";
import {
  getResolvedSpeechProviderConfigForVoiceModel,
  mergeProviderConfigWithPersona,
  resolvePersonaProviderConfig,
  resolvePrimaryTtsProviderCandidate,
  resolveSpeechProviderTimeoutMs,
  resolveTtsProvider,
  resolveTtsProviderCandidates,
} from "./tts-provider-resolution.js";
import {
  getTtsPersona,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsRuntimeConfig,
  type ResolvedTtsConfig,
} from "./tts-settings.js";
import type { TtsProviderAttempt } from "./tts-types.js";

export function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${redactSensitiveText(error.message)}`;
}

export function sanitizeTtsErrorForLog(err: unknown): string {
  const raw = formatErrorMessage(err);
  return redactSensitiveText(raw).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

export function buildTtsFailureResult(
  errors: string[],
  attemptedProviders?: string[],
  attempts?: TtsProviderAttempt[],
  persona?: string,
): {
  success: false;
  error: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  persona?: string;
} {
  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
    attemptedProviders,
    attempts,
    persona,
  };
}

type TtsProviderReadyResolution =
  | {
      kind: "ready";
      provider: NonNullable<ReturnType<typeof getSpeechProvider>>;
      providerConfig: SpeechProviderConfig;
      personaProviderConfig?: SpeechProviderConfig;
      synthesisPersona?: ResolvedTtsPersona;
      personaBinding: "applied" | "missing" | "none";
    }
  | {
      kind: "skip";
      reasonCode: "no_provider_registered" | "not_configured" | "unsupported_for_telephony";
      message: string;
      personaBinding?: "missing";
    };

export function resolveReadySpeechProvider(params: {
  provider: TtsProvider;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  voiceModel?: VoiceModelRef;
  requireTelephony?: boolean;
}): TtsProviderReadyResolution {
  const resolvedProvider = getSpeechProvider(params.provider, params.cfg);
  if (!resolvedProvider) {
    return {
      kind: "skip",
      reasonCode: "no_provider_registered",
      message: `${params.provider}: no provider registered`,
    };
  }
  const providerConfig = getResolvedSpeechProviderConfigForVoiceModel({
    config: params.config,
    providerId: resolvedProvider.id,
    cfg: params.cfg,
    voiceModel: params.voiceModel,
  });
  const merged = mergeProviderConfigWithPersona({
    providerConfig,
    persona: params.persona,
    providerId: resolvedProvider.id,
  });
  if (params.persona?.fallbackPolicy === "fail" && merged.personaBinding === "missing") {
    return {
      kind: "skip",
      reasonCode: "not_configured",
      message: `${params.provider}: persona ${params.persona.id} has no provider binding`,
      personaBinding: "missing",
    };
  }
  if (
    !resolvedProvider.isConfigured({
      cfg: params.cfg,
      providerConfig: merged.providerConfig,
      timeoutMs: resolveSpeechProviderTimeoutMs({
        config: params.config,
        provider: resolvedProvider,
      }),
    })
  ) {
    return {
      kind: "skip",
      reasonCode: "not_configured",
      message: `${params.provider}: not configured`,
    };
  }
  if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) {
    return {
      kind: "skip",
      reasonCode: "unsupported_for_telephony",
      message: `${params.provider}: unsupported for telephony`,
    };
  }
  return {
    kind: "ready",
    provider: resolvedProvider,
    providerConfig: merged.providerConfig,
    personaProviderConfig: merged.personaProviderConfig,
    synthesisPersona:
      params.persona?.fallbackPolicy === "provider-defaults" && merged.personaBinding === "missing"
        ? undefined
        : params.persona,
    personaBinding: merged.personaBinding,
  };
}

export async function prepareSpeechSynthesis(params: {
  provider: NonNullable<ReturnType<typeof getSpeechProvider>>;
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  persona?: ResolvedTtsPersona;
  personaProviderConfig?: SpeechProviderConfig;
  target: "audio-file" | "voice-note" | "telephony";
  timeoutMs: number;
}): Promise<{
  text: string;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
}> {
  if (!params.provider.prepareSynthesis) {
    return {
      text: params.text,
      providerConfig: params.providerConfig,
      providerOverrides: params.providerOverrides,
    };
  }
  const prepared = await params.provider.prepareSynthesis({
    text: params.text,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    providerOverrides: params.providerOverrides,
    persona: params.persona,
    personaProviderConfig: params.personaProviderConfig,
    target: params.target,
    timeoutMs: params.timeoutMs,
  });
  return {
    text: prepared?.text ?? params.text,
    providerConfig: prepared?.providerConfig
      ? { ...params.providerConfig, ...prepared.providerConfig }
      : params.providerConfig,
    providerOverrides: prepared?.providerOverrides
      ? { ...params.providerOverrides, ...prepared.providerOverrides }
      : params.providerOverrides,
  };
}

export function resolveTtsRequestSetup(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}):
  | {
      cfg: OpenClawConfig;
      config: ResolvedTtsConfig;
      persona?: ResolvedTtsPersona;
      providers: VoiceProviderCandidate[];
    }
  | {
      error: string;
    } {
  const cfg = resolveTtsRuntimeConfig(params.cfg);
  const config = resolveTtsConfig(cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  const userProvider = resolveTtsProvider(config, prefsPath);
  const provider = canonicalizeSpeechProviderId(params.providerOverride, cfg) ?? userProvider;
  return {
    cfg,
    config,
    persona: getTtsPersona(config, prefsPath),
    providers: params.disableFallback
      ? [resolvePrimaryTtsProviderCandidate(provider, cfg)]
      : resolveTtsProviderCandidates(provider, cfg),
  };
}

function readTtsResultString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveTtsResultModel(
  providerConfig: SpeechProviderConfig,
  providerOverrides?: SpeechProviderOverrides,
): string | undefined {
  return (
    readTtsResultString(providerOverrides?.modelId) ??
    readTtsResultString(providerOverrides?.model) ??
    readTtsResultString(providerConfig.modelId) ??
    readTtsResultString(providerConfig.model)
  );
}

export function resolveTtsResultVoice(
  providerConfig: SpeechProviderConfig,
  providerOverrides?: SpeechProviderOverrides,
): string | undefined {
  return (
    readTtsResultString(providerOverrides?.speakerVoiceId) ??
    readTtsResultString(providerOverrides?.speakerVoice) ??
    readTtsResultString(providerOverrides?.voiceId) ??
    readTtsResultString(providerOverrides?.voiceName) ??
    readTtsResultString(providerOverrides?.voice) ??
    readTtsResultString(providerConfig.speakerVoiceId) ??
    readTtsResultString(providerConfig.speakerVoice) ??
    readTtsResultString(providerConfig.voiceId) ??
    readTtsResultString(providerConfig.voiceName) ??
    readTtsResultString(providerConfig.voice)
  );
}

export function resolvePersonaBinding(
  persona: ResolvedTtsPersona | undefined,
  provider: string,
): "applied" | "missing" | "none" {
  return resolvePersonaProviderConfig(persona, provider) != null
    ? "applied"
    : persona
      ? "missing"
      : "none";
}
