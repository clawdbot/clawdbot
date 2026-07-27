// Voice Call plugin module implements telephony tts behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { TtsDirectiveOverrides, TtsDirectiveParseResult } from "openclaw/plugin-sdk/speech";
import type { VoiceCallTtsConfig } from "./config.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

// Telephony TTS adapter that applies voice-call overrides and emits 8kHz mulaw audio.

/** Core runtime TTS API used by the telephony adapter. */
export type TelephonyTtsRuntime = {
  prepareTtsRequest: (params: {
    cfg: OpenClawConfig;
    override?: VoiceCallTtsConfig;
    text: string;
  }) => Promise<{
    cfg: OpenClawConfig;
    directives: TtsDirectiveParseResult;
  }>;
  textToSpeechTelephony: (params: {
    text: string;
    cfg: OpenClawConfig;
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

/** Provider facade used by Twilio/webhook code for telephony synthesis. */
export type TelephonyTtsProvider = {
  synthesisTimeoutMs: number;
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
};

/** Default timeout for one telephony synthesis request. */
export const TELEPHONY_DEFAULT_TTS_TIMEOUT_MS = 8000;

/** Create a TTS provider that honors voice-call overrides and converts PCM to mulaw. */
export async function createTelephonyTtsProvider(params: {
  coreConfig: OpenClawConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
  logger?: {
    warn?: (message: string) => void;
  };
}): Promise<TelephonyTtsProvider> {
  const { coreConfig, ttsOverride, runtime, logger } = params;
  const preparedConfig = await runtime.prepareTtsRequest({
    cfg: coreConfig,
    override: ttsOverride,
    text: "",
  });
  const synthesisTimeoutMs = resolveTimerTimeoutMs(
    preparedConfig.cfg.tts?.timeoutMs,
    TELEPHONY_DEFAULT_TTS_TIMEOUT_MS,
  );

  return {
    synthesisTimeoutMs,
    synthesizeForTelephony: async (text: string) => {
      const prepared = await runtime.prepareTtsRequest({
        cfg: preparedConfig.cfg,
        text,
      });
      const directives = prepared.directives;
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
        cfg: prepared.cfg,
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
