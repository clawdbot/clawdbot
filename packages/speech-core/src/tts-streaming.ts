import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TtsDirectiveOverrides } from "openclaw/plugin-sdk/speech-core";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { resolveSpeechProviderTimeoutMs } from "./tts-provider-resolution.js";
import {
  buildTtsFailureResult,
  formatTtsProviderError,
  prepareSpeechSynthesis,
  resolvePersonaBinding,
  resolveReadySpeechProvider,
  resolveTtsRequestSetup,
  resolveTtsResultModel,
  resolveTtsResultVoice,
  sanitizeTtsErrorForLog,
} from "./tts-synthesis-support.js";
import { resolveTtsSynthesisTarget } from "./tts-synthesis.js";
import type { TtsProviderAttempt, TtsStreamResult, TtsSynthesisStreamResult } from "./tts-types.js";

export async function streamSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisStreamResult> {
  assertSpeechRuntimeAvailable();
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  const target = resolveTtsSynthesisTarget(params.channel);
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0]?.provider;
  logVerbose(
    `TTS stream: starting with provider ${primaryProvider}, fallbacks: ${
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
        logVerbose(`TTS stream: provider ${provider} skipped (${resolvedProvider.message})`);
        continue;
      }
      if (!resolvedProvider.provider.streamSynthesize) {
        const message = `${provider} does not support streaming TTS`;
        errors.push(message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: "unsupported_for_streaming",
          persona: persona?.id,
          personaBinding: resolvedProvider.personaBinding,
          error: message,
        });
        logVerbose(`TTS stream: provider ${provider} skipped (${message})`);
        continue;
      }
      const timeoutMs = resolveSpeechProviderTimeoutMs({
        timeoutMs: params.timeoutMs ?? voiceModel?.timeoutMs,
        config,
        provider: resolvedProvider.provider,
      });
      const prepared = await prepareSpeechSynthesis({
        provider: resolvedProvider.provider,
        text: params.text,
        cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.provider.id],
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target,
        timeoutMs,
      });
      const synthesis = await resolvedProvider.provider.streamSynthesize({
        text: prepared.text,
        cfg,
        providerConfig: prepared.providerConfig,
        target,
        providerOverrides: prepared.providerOverrides,
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
      return {
        success: true,
        audioStream: synthesis.audioStream,
        latencyMs,
        provider,
        providerModel: resolveTtsResultModel(prepared.providerConfig, prepared.providerOverrides),
        providerVoice: resolveTtsResultVoice(prepared.providerConfig, prepared.providerOverrides),
        persona: persona?.id,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        attemptedProviders,
        attempts,
        outputFormat: synthesis.outputFormat,
        voiceCompatible: synthesis.voiceCompatible,
        fileExtension: synthesis.fileExtension,
        target,
        release: synthesis.release,
      };
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
          `TTS stream: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`TTS stream: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}

export async function textToSpeechStream(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsStreamResult> {
  const synthesis = await streamSpeech(params);
  if (!synthesis.success || !synthesis.audioStream || !synthesis.fileExtension) {
    return {
      success: false,
      error: synthesis.error ?? "Streaming TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }
  return synthesis;
}
