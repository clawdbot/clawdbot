import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsProvider,
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
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

function buildTtsFailureResult(
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

function resolveReadySpeechProvider(params: {
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

async function prepareSpeechSynthesis(params: {
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

type ReadySpeechProvider = Extract<TtsProviderReadyResolution, { kind: "ready" }>;
type PreparedSpeechSynthesis = Awaited<ReturnType<typeof prepareSpeechSynthesis>>;
type TtsProviderOperation<TSynthesis> =
  | {
      kind: "ready";
      synthesize: (params: {
        prepared: PreparedSpeechSynthesis;
        cfg: OpenClawConfig;
        target: "audio-file" | "voice-note" | "telephony";
        timeoutMs: number;
      }) => Promise<TSynthesis>;
    }
  | {
      kind: "skip";
      reasonCode: TtsProviderAttempt["reasonCode"];
      message: string;
    };
type TtsProviderSuccess<TSynthesis> = {
  synthesis: TSynthesis;
  latencyMs: number;
  provider: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders: string[];
  attempts: TtsProviderAttempt[];
};

export async function executeTtsProviderAttempts<TSynthesis, TResult>(params: {
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  providers: VoiceProviderCandidate[];
  synthesisText: string;
  providerOverrides?: Record<string, SpeechProviderOverrides>;
  timeoutMs?: number;
  target: "audio-file" | "voice-note" | "telephony";
  logLabel: string;
  requireTelephony?: boolean;
  selectOperation: (params: {
    provider: TtsProvider;
    resolvedProvider: ReadySpeechProvider;
  }) => TtsProviderOperation<TSynthesis>;
  buildSuccess: (params: TtsProviderSuccess<TSynthesis>) => TResult;
}): Promise<TResult | ReturnType<typeof buildTtsFailureResult>> {
  const { cfg, config, persona, providers } = params;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0]?.provider;
  logVerbose(
    `${params.logLabel}: starting with provider ${primaryProvider}, fallbacks: ${
      providers
        .slice(1)
        .map((entry) => entry.provider)
        .join(", ") || "none"
    }`,
  );

  for (const { provider, voiceModel } of providers) {
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg,
        config,
        persona,
        voiceModel,
        requireTelephony: params.requireTelephony,
      });
      if (resolvedProvider.kind === "skip") {
        errors.push(resolvedProvider.message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: resolvedProvider.reasonCode,
          persona: persona?.id,
          ...(resolvedProvider.personaBinding
            ? { personaBinding: resolvedProvider.personaBinding }
            : {}),
          error: resolvedProvider.message,
        });
        logVerbose(
          `${params.logLabel}: provider ${provider} skipped (${resolvedProvider.message})`,
        );
        continue;
      }

      const operation = params.selectOperation({ provider, resolvedProvider });
      if (operation.kind === "skip") {
        errors.push(operation.message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: operation.reasonCode,
          persona: persona?.id,
          personaBinding: resolvedProvider.personaBinding,
          error: operation.message,
        });
        logVerbose(`${params.logLabel}: provider ${provider} skipped (${operation.message})`);
        continue;
      }

      const timeoutMs = resolveSpeechProviderTimeoutMs({
        timeoutMs: params.timeoutMs ?? voiceModel?.timeoutMs,
        config,
        provider: resolvedProvider.provider,
      });
      const prepared = await prepareSpeechSynthesis({
        provider: resolvedProvider.provider,
        text: params.synthesisText,
        cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.providerOverrides?.[resolvedProvider.provider.id],
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target: params.target,
        timeoutMs,
      });
      const synthesis = await operation.synthesize({
        prepared,
        cfg,
        target: params.target,
        timeoutMs,
      });
      const latencyMs = Date.now() - providerStart;
      attempts.push({
        provider,
        outcome: "success",
        reasonCode: "success",
        persona: persona?.id,
        personaBinding: resolvedProvider.personaBinding,
        latencyMs,
      });
      return params.buildSuccess({
        synthesis,
        latencyMs,
        provider,
        providerModel: resolveTtsResultModel(prepared.providerConfig, prepared.providerOverrides),
        providerVoice: resolveTtsResultVoice(prepared.providerConfig, prepared.providerOverrides),
        persona: persona?.id,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        attemptedProviders,
        attempts,
      });
    } catch (err) {
      const errorMsg = formatTtsProviderError(provider, err);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode:
          err instanceof Error && err.name === "AbortError" ? "timeout" : "provider_error",
        latencyMs,
        persona: persona?.id,
        personaBinding: resolvePersonaBinding(persona, provider),
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(err);
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `${params.logLabel}: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`${params.logLabel}: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}

function readTtsResultString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveTtsResultModel(
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

function resolveTtsResultVoice(
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

function resolvePersonaBinding(
  persona: ResolvedTtsPersona | undefined,
  provider: string,
): "applied" | "missing" | "none" {
  return resolvePersonaProviderConfig(persona, provider) != null
    ? "applied"
    : persona
      ? "missing"
      : "none";
}
