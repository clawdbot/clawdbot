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
import type { TtsProviderAttempt, TtsTelephonyResult } from "./tts-types.js";

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
  timeoutMs?: number;
}): Promise<TtsTelephonyResult> {
  assertSpeechRuntimeAvailable();
  const setup = resolveTtsRequestSetup({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
  });
  if ("error" in setup) {
    return { success: false, error: setup.error };
  }

  const { cfg, config, persona, providers } = setup;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0]?.provider;
  logVerbose(
    `TTS telephony: starting with provider ${primaryProvider}, fallbacks: ${
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
        requireTelephony: true,
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
        logVerbose(`TTS telephony: provider ${provider} skipped (${resolvedProvider.message})`);
        continue;
      }
      const timeoutMs = resolveSpeechProviderTimeoutMs({
        timeoutMs: params.timeoutMs ?? voiceModel?.timeoutMs,
        config,
        provider: resolvedProvider.provider,
      });
      const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony as NonNullable<
        typeof resolvedProvider.provider.synthesizeTelephony
      >;
      const prepared = await prepareSpeechSynthesis({
        provider: resolvedProvider.provider,
        text: params.text,
        cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.provider.id],
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target: "telephony",
        timeoutMs,
      });
      const synthesis = await synthesizeTelephony({
        text: prepared.text,
        cfg,
        providerConfig: prepared.providerConfig,
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
        audioBuffer: synthesis.audioBuffer,
        latencyMs,
        provider,
        providerModel: resolveTtsResultModel(prepared.providerConfig, prepared.providerOverrides),
        providerVoice: resolveTtsResultVoice(prepared.providerConfig, prepared.providerOverrides),
        persona: persona?.id,
        fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
        attemptedProviders,
        attempts,
        outputFormat: synthesis.outputFormat,
        sampleRate: synthesis.sampleRate,
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
          `TTS telephony: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`TTS telephony: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}
