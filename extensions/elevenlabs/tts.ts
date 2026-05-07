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

type ElevenLabsTtsRequestParams = {
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
};

function prepareElevenLabsTtsRequest(params: ElevenLabsTtsRequestParams & { stream: boolean }): {
  url: URL;
  normalizedBaseUrl: string;
  acceptHeader?: string;
  body: string;
} {
  const {
    text,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    latencyTier,
    voiceSettings,
  } = params;
  if (!isValidElevenLabsVoiceId(voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsVoiceSettings(voiceSettings);
  const normalizedLanguage = normalizeLanguageCode(languageCode);
  const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
  const normalizedSeed = normalizeSeed(seed);
  const normalizedBaseUrl = normalizeElevenLabsBaseUrl(baseUrl);
  const normalizedLatencyTier =
    typeof latencyTier === "number" && Number.isFinite(latencyTier)
      ? Math.trunc(latencyTier)
      : undefined;
  if (normalizedLatencyTier !== undefined) {
    requireInRange(normalizedLatencyTier, 0, 4, "latencyTier");
  }
  const url = new URL(
    `${normalizedBaseUrl}/v1/text-to-speech/${voiceId}${params.stream ? "/stream" : ""}`,
  );
  if (outputFormat) {
    url.searchParams.set("output_format", outputFormat);
  }
  const supportsStreamingLatency = modelId.trim().toLowerCase() !== "eleven_v3";
  if (normalizedLatencyTier !== undefined && supportsStreamingLatency) {
    url.searchParams.set("optimize_streaming_latency", normalizedLatencyTier.toString());
  }
  const acceptHeader = resolveElevenLabsAcceptHeader(outputFormat);
  return {
    url,
    normalizedBaseUrl,
    acceptHeader,
    body: JSON.stringify({
      text,
      model_id: modelId,
      seed: normalizedSeed,
      apply_text_normalization: normalizedNormalization,
      language_code: normalizedLanguage,
      voice_settings: {
        stability: voiceSettings.stability,
        similarity_boost: voiceSettings.similarityBoost,
        style: voiceSettings.style,
        use_speaker_boost: voiceSettings.useSpeakerBoost,
        speed: voiceSettings.speed,
      },
    }),
  };
}

export async function elevenLabsTTS(params: ElevenLabsTtsRequestParams): Promise<Buffer> {
  const { apiKey, timeoutMs } = params;
  const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
    ...params,
    stream: false,
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body,
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

export async function elevenLabsTTSStream(params: ElevenLabsTtsRequestParams): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const { apiKey, timeoutMs } = params;
  const { url, normalizedBaseUrl, acceptHeader, body } = prepareElevenLabsTtsRequest({
    ...params,
    stream: true,
  });

  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
      },
      body,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
    auditContext: "elevenlabs.tts.stream",
  });
  let handedOff = false;
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");
    if (!response.body) {
      throw new Error("ElevenLabs API response missing audio stream");
    }
    handedOff = true;
    return {
      audioStream: response.body,
      release,
    };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}
