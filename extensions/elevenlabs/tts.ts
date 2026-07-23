// Elevenlabs plugin module implements tts behavior.
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/media-runtime";
import {
  assertOkOrThrowProviderError,
  assertProviderBinaryResponseContent,
  readProviderBinaryResponse,
} from "openclaw/plugin-sdk/provider-http";
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

function normalizeElevenLabsLatencyTier(latencyTier: number | undefined): number | undefined {
  if (latencyTier === undefined || !Number.isFinite(latencyTier)) {
    return undefined;
  }
  if (!Number.isSafeInteger(latencyTier)) {
    throw new Error("latencyTier must be an integer");
  }
  requireInRange(latencyTier, 0, 4, "latencyTier");
  return latencyTier;
}

// Mirror the buffered cap without buffering. Own the reader because Node can leak
// transform writer rejections when playback cancellation races an overflow.
function createBoundedElevenLabsAudioStream(stream: ReadableStream<Uint8Array>): {
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
} {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let totalBytes = 0;

  const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array>) => {
    if (reader !== activeReader) {
      return;
    }
    reader = undefined;
    activeReader.releaseLock();
  };

  const cancelReader = async (reason?: unknown) => {
    const activeReader = reader;
    if (!activeReader) {
      return;
    }
    try {
      await activeReader.cancel(reason).catch(() => undefined);
    } finally {
      releaseReader(activeReader);
    }
  };

  const audioStream = new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
    },
    async pull(controller) {
      const activeReader = reader;
      if (!activeReader) {
        controller.close();
        return;
      }
      try {
        const chunk = await activeReader.read();
        if (chunk.done) {
          releaseReader(activeReader);
          controller.close();
          return;
        }
        const remainingBytes = MAX_AUDIO_BYTES - totalBytes;
        if (chunk.value.byteLength > remainingBytes) {
          if (remainingBytes > 0) {
            controller.enqueue(chunk.value.subarray(0, remainingBytes));
          }
          const error = new Error(
            `ElevenLabs API error: audio response exceeds ${MAX_AUDIO_BYTES} bytes`,
          );
          await activeReader.cancel(error).catch(() => undefined);
          releaseReader(activeReader);
          controller.error(error);
          return;
        }
        totalBytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseReader(activeReader);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelReader(reason);
    },
  });

  return {
    audioStream,
    release: () => cancelReader(new Error("ElevenLabs TTS stream released")),
  };
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
  const normalizedLatencyTier = normalizeElevenLabsLatencyTier(latencyTier);
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

  const { response, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
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
    }),
  );
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");

    return Buffer.from(await readProviderBinaryResponse(response, "ElevenLabs API error", "audio"));
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

  const { response, release } = await fetchWithSsrFGuard(
    withTrustedEnvProxyGuardedFetchMode({
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
    }),
  );
  let handedOff = false;
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs API error");
    assertProviderBinaryResponseContent(response, "ElevenLabs API error", "audio");
    if (!response.body) {
      throw new Error("ElevenLabs API response missing audio stream");
    }
    const boundedStream = createBoundedElevenLabsAudioStream(response.body);
    let releasePromise: Promise<void> | undefined;
    const releaseAll = () => {
      releasePromise ??= (async () => {
        try {
          await boundedStream.release();
        } finally {
          await release();
        }
      })();
      return releasePromise;
    };
    handedOff = true;
    return {
      audioStream: boundedStream.audioStream,
      release: releaseAll,
    };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}
