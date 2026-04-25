import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "openclaw/plugin-sdk/speech";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isValidElevenLabsVoiceId, normalizeElevenLabsBaseUrl } from "./shared.js";

function assertElevenLabsVoiceSettings(settings: {
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  speed: number;
}) {
  requireInRange(settings.stability, 0, 1, "stability");
  requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
  requireInRange(settings.style, 0, 1, "style");
  requireInRange(settings.speed, 0.5, 2, "speed");
}

function resolveElevenLabsAcceptHeader(outputFormat: string): string | undefined {
  const normalized = outputFormat.trim().toLowerCase();
  if (!normalized || normalized.startsWith("mp3_")) {
    return "audio/mpeg";
  }
  return undefined;
}

export async function elevenLabsTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  latencyTier?: number;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    style: number;
    useSpeakerBoost: boolean;
    speed: number;
  };
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    latencyTier,
    voiceSettings,
    timeoutMs,
  } = params;
  if (!isValidElevenLabsVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsVoiceSettings(voiceSettings);
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const normalizedSeed = normalizeSeed(seed);
  const normalizedBaseUrl = normalizeElevenLabsBaseUrl(baseUrl);
  const url = new URL(`${normalizedBaseUrl}/v1/text-to-speech/${voiceId}`);
  if (outputFormat) {
    url.searchParams.set("output_format", outputFormat);
  }
  const acceptHeader = resolveElevenLabsAcceptHeader(outputFormat);

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        seed: normalizedSeed,
        apply_text_normalization: normalizedNormalization,
        language_code: normalizedLanguage,
        latency_optimization_level: latencyTier,
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
          speed: voiceSettings.speed,
        },
      }),
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
    auditContext: "elevenlabs.tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");

    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
