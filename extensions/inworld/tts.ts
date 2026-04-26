import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech-core";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
export const DEFAULT_INWORLD_VOICE_ID = "Sarah";
export const DEFAULT_INWORLD_MODEL_ID = "inworld-tts-1.5-max";

export const INWORLD_TTS_MODELS = [
  "inworld-tts-1.5-max",
  "inworld-tts-1.5-mini",
  "inworld-tts-1-max",
  "inworld-tts-1",
] as const;

export type InworldAudioEncoding =
  | "MP3"
  | "OGG_OPUS"
  | "LINEAR16"
  | "PCM"
  | "WAV"
  | "ALAW"
  | "MULAW"
  | "FLAC";

export function normalizeInworldBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_INWORLD_BASE_URL;
}

function ssrfPolicyFromInworldBaseUrl(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { hostnameAllowlist: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

/**
 * Calls the Inworld streaming TTS endpoint and concatenates every audio chunk
 * into a single buffer. The stream returns newline-delimited JSON, each line
 * carrying base64 audio in `result.audioContent`.
 */
export async function inworldTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  modelId?: string;
  audioEncoding?: InworldAudioEncoding;
  sampleRateHertz?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
  const url = `${baseUrl}/tts/v1/voice:stream`;
  const requestBody = JSON.stringify({
    text: params.text,
    voiceId: params.voiceId ?? DEFAULT_INWORLD_VOICE_ID,
    modelId: params.modelId ?? DEFAULT_INWORLD_MODEL_ID,
    audioConfig: {
      audioEncoding: params.audioEncoding ?? "MP3",
      ...(params.sampleRateHertz && { sampleRateHertz: params.sampleRateHertz }),
    },
    ...(params.temperature != null && { temperature: params.temperature }),
  });

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // apiKey is the Base64-encoded credential string copied from the
        // Inworld dashboard; it is sent verbatim as the HTTP Basic
        // credential. Do not Base64-encode it here, and do not normalize
        // bearer-style tokens.
        Authorization: `Basic ${params.apiKey}`,
      },
      body: requestBody,
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromInworldBaseUrl(baseUrl),
    auditContext: "inworld-tts",
  });

  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Inworld TTS API error (${response.status}): ${errorBody}`);
    }

    const body = await response.text();
    const chunks: Buffer[] = [];

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: {
        result?: { audioContent?: string };
        error?: { code?: number; message?: string };
      };
      try {
        parsed = JSON.parse(trimmed) as typeof parsed;
      } catch {
        throw new Error(
          `Inworld TTS stream parse error: unexpected non-JSON line: ${trimmed.slice(0, 80)}`,
        );
      }

      if (parsed.error) {
        throw new Error(`Inworld TTS stream error (${parsed.error.code}): ${parsed.error.message}`);
      }

      if (parsed.result?.audioContent) {
        chunks.push(Buffer.from(parsed.result.audioContent, "base64"));
      }
    }

    if (chunks.length === 0) {
      throw new Error("Inworld TTS returned no audio data");
    }

    return Buffer.concat(chunks);
  } finally {
    await release();
  }
}

export async function listInworldVoices(params: {
  apiKey: string;
  baseUrl?: string;
  language?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
  const langParam = params.language ? `?languages=${encodeURIComponent(params.language)}` : "";
  const url = `${baseUrl}/voices/v1/voices${langParam}`;

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "GET",
      headers: {
        Authorization: `Basic ${params.apiKey}`,
      },
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromInworldBaseUrl(baseUrl),
    auditContext: "inworld-voices",
  });

  try {
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Inworld voices API error (${response.status}): ${errorBody}`);
    }

    const json = (await response.json()) as {
      voices?: Array<{
        voiceId?: string;
        displayName?: string;
        description?: string;
        langCode?: string;
        tags?: string[];
        source?: string;
      }>;
    };

    return Array.isArray(json.voices)
      ? json.voices
          .map((voice) => ({
            id: voice.voiceId?.trim() ?? "",
            name: voice.displayName?.trim() || undefined,
            description: voice.description?.trim() || undefined,
            locale: voice.langCode || undefined,
            gender: voice.tags?.find((t) => t === "male" || t === "female") || undefined,
          }))
          .filter((voice) => voice.id.length > 0)
      : [];
  } finally {
    await release();
  }
}
