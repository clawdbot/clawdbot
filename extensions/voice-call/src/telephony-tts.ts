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
    outputFormat?: string;
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

class UnsupportedTelephonyTtsOutputFormatError extends Error {
  constructor(
    readonly outputFormat: string,
    readonly provider: string,
  ) {
    super(`Unsupported telephony TTS output format "${outputFormat}" from provider "${provider}"`);
    this.name = "UnsupportedTelephonyTtsOutputFormatError";
  }
}

function convertTelephonyTtsOutput(result: {
  audioBuffer: Buffer;
  outputFormat?: string;
  provider?: string;
  sampleRate: number;
}): Buffer {
  const format = result.outputFormat?.trim().toLowerCase();
  // Bundled provider contracts: Azure/Gradium emit raw-8khz-8bit-mono-mulaw/ulaw_8000;
  // ElevenLabs/OpenAI emit pcm_22050/pcm. An absent format is the shipped PCM default.
  const isMulaw = format?.includes("mulaw") || format?.includes("ulaw");
  const names8Khz = format?.includes("8khz") || format?.includes("8000");
  if (isMulaw && names8Khz && result.sampleRate === 8_000) {
    return result.audioBuffer;
  }
  const isPcm =
    !format ||
    format === "pcm" ||
    /^pcm[_-]\d+$/.test(format) ||
    (format.includes("raw") &&
      (format.includes("16bit") || format.includes("16-bit")) &&
      format.includes("pcm"));
  if (isPcm) {
    return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
  }
  throw new UnsupportedTelephonyTtsOutputFormatError(
    result.outputFormat ?? "absent",
    result.provider ?? "unknown",
  );
}

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

      return convertTelephonyTtsOutput({
        audioBuffer: result.audioBuffer,
        outputFormat: result.outputFormat,
        provider: result.provider,
        sampleRate: result.sampleRate,
      });
    },
  };
}
