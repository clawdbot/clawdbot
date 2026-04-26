import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";

export const MINIMAX_TTS_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
  "speech-01-240228",
] as const;

export const MINIMAX_TTS_VOICES = [
  "English_expressive_narrator",
  "Chinese (Mandarin)_Warm_Girl",
  "Chinese (Mandarin)_Lively_Girl",
  "Chinese (Mandarin)_Gentle_Boy",
  "Chinese (Mandarin)_Steady_Boy",
] as const;

export function normalizeMinimaxTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_MINIMAX_TTS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "").replace(/\/(?:anthropic|v1)$/i, "");
}

function normalizeMinimaxTtsPitch(pitch: number): number {
  return Math.trunc(pitch);
}

export async function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: string;
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    model,
    voiceId,
    speed = 1.0,
    vol = 1.0,
    pitch = 0,
    format = "mp3",
    sampleRate = 32000,
    timeoutMs,
  } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/v1/t2a_v2`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          text,
          voice_setting: {
            voice_id: voiceId,
            speed,
            vol,
            pitch: normalizeMinimaxTtsPitch(pitch),
          },
          audio_setting: {
            format,
            sample_rate: sampleRate,
          },
        }),
        signal: controller.signal,
      },
      timeoutMs,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
      auditContext: "minimax.tts",
    });
    try {
      await assertOkOrThrowProviderError(response, "MiniMax TTS API error");

      const body = (await response.json()) as { data?: { audio?: string } };
      const hexAudio = body?.data?.audio;
      if (!hexAudio) {
        throw new Error("MiniMax TTS API returned no audio data");
      }

      return Buffer.from(hexAudio, "hex");
    } finally {
      await release();
    }
  } finally {
    clearTimeout(timeout);
  }
}
