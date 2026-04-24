import { postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import { extractProviderErrorDetail, trimToUndefined } from "openclaw/plugin-sdk/speech";
import { XAI_BASE_URL } from "./api.js";
export { XAI_BASE_URL };

export const XAI_TTS_VOICES = ["eve", "ara", "rex", "sal", "leo", "una"] as const;

type XaiTtsVoice = (typeof XAI_TTS_VOICES)[number];

export function normalizeXaiTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return XAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export function isValidXaiTtsVoice(voice: string, baseUrl?: string): voice is XaiTtsVoice {
  const normalizedBase = normalizeXaiTtsBaseUrl(baseUrl ?? process.env.XAI_BASE_URL);
  const host = normalizedBase.includes("://") ? new URL(normalizedBase).hostname : normalizedBase;
  const isNative = host === "api.x.ai" || host === "api.grok.x.ai";
  if (!isNative) {
    return true;
  }
  return XAI_TTS_VOICES.includes(voice as XaiTtsVoice);
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

async function extractXaiErrorDetail(response: Response): Promise<string | undefined> {
  return await extractProviderErrorDetail(response);
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
  } = params;
  const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";

  if (!isValidXaiTtsVoice(voiceId, baseUrl)) {
    throw new Error(`Invalid voice: ${voiceId}`);
  }

  const { response, release } = await postJsonRequest({
    url: `${normalizeXaiTtsBaseUrl(baseUrl)}/tts`,
    headers: new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
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
    if (!response.ok) {
      const detail = await extractXaiErrorDetail(response);
      const requestId =
        trimToUndefined(response.headers.get("x-request-id")) ??
        trimToUndefined(response.headers.get("request-id"));
      throw new Error(
        `xAI TTS API error (${response.status})` +
          (detail ? `: ${detail}` : "") +
          (requestId ? ` [request_id=${requestId}]` : ""),
      );
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
