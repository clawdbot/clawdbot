// Xai plugin module implements tts behavior.
import {
  assertOkOrThrowProviderError,
  postJsonRequest,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { asObject, trimToUndefined, type SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { XAI_BASE_URL } from "./api.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";
export { XAI_BASE_URL };

const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;
const XAI_TTS_VOICE_LIST_TIMEOUT_MS = 30_000;
const XAI_TTS_VOICE_LIST_MAX_BYTES = 1024 * 1024;
export const XAI_TTS_FALLBACK_VOICES = ["ara", "eve", "leo", "rex", "sal"] as const;

export function normalizeXaiTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return XAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export function isValidXaiTtsVoice(voice: string): boolean {
  return trimToUndefined(voice) !== undefined;
}

export async function listXaiTtsVoices(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const baseUrl = normalizeXaiTtsBaseUrl(params.baseUrl);
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/tts/voices`,
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        ...xaiUserAgentHeaderFor(baseUrl),
      },
    },
    timeoutMs: XAI_TTS_VOICE_LIST_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "xai tts voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS voices API error");
    const payload = await readProviderJsonResponse<unknown>(response, "xAI TTS voices", {
      maxBytes: XAI_TTS_VOICE_LIST_MAX_BYTES,
    });
    const voices = asObject(payload)?.voices;
    if (!Array.isArray(voices)) {
      throw new Error("xAI TTS voices: malformed JSON response");
    }
    return voices.flatMap((value) => {
      const voice = asObject(value);
      const id = trimToUndefined(voice?.voice_id);
      if (!id) {
        return [];
      }
      return [
        {
          id,
          name: trimToUndefined(voice?.name),
          locale: trimToUndefined(voice?.language),
          gender: trimToUndefined(voice?.gender),
        },
      ];
    });
  } finally {
    await release();
  }
}

export function normalizeXaiLanguageCode(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) {
    return normalized;
  }
  throw new Error(
    `xAI language must be "auto" or a BCP-47 tag (e.g. "en", "pt-br", "zh-cn"); got: ${normalized}`,
  );
}

export async function xaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: "mp3" | "wav" | "pcm" | "mulaw" | "alaw";
  timeoutMs: number;
  maxBytes?: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    language: rawLanguage,
    speed,
    responseFormat = "mp3",
    timeoutMs,
    maxBytes = DEFAULT_TTS_MAX_BYTES,
  } = params;
  const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";

  if (!isValidXaiTtsVoice(voiceId)) {
    throw new Error(`Invalid voice: ${voiceId}`);
  }

  const ttsBaseUrl = normalizeXaiTtsBaseUrl(baseUrl);
  const { response, release } = await postJsonRequest({
    url: `${ttsBaseUrl}/tts`,
    headers: new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...xaiUserAgentHeaderFor(ttsBaseUrl),
    }),
    body: {
      text,
      voice_id: voiceId,
      language,
      output_format: {
        codec: responseFormat,
      },
      ...(speed != null && { speed }),
    },
    timeoutMs,
    fetchFn: fetch,
    auditContext: "xai tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS API error");

    return await readResponseWithLimit(response, maxBytes, {
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`xAI TTS audio response exceeds ${maxBytesLocal} bytes`),
    });
  } finally {
    await release();
  }
}
