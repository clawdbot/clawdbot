import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech-core";
import { trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_AZURE_SPEECH_VOICE = "en-US-JennyNeural";
export const DEFAULT_AZURE_SPEECH_LANG = "en-US";
export const DEFAULT_AZURE_SPEECH_AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
export const DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT = "ogg-24khz-16bit-mono-opus";
export const DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT = "raw-8khz-8bit-mono-mulaw";

type AzureSpeechVoiceEntry = {
  ShortName?: string;
  DisplayName?: string;
  LocalName?: string;
  Locale?: string;
  Gender?: string;
  Status?: string;
  IsDeprecated?: boolean | string;
  VoiceTag?: {
    VoicePersonalities?: string[];
    TailoredScenarios?: string[];
  };
};

export function normalizeAzureSpeechBaseUrl(params: {
  baseUrl?: string;
  endpoint?: string;
  region?: string;
}): string | undefined {
  const configured = trimToUndefined(params.baseUrl) ?? trimToUndefined(params.endpoint);
  if (configured) {
    return configured.replace(/\/+$/, "").replace(/\/cognitiveservices\/v1$/i, "");
  }
  const region = trimToUndefined(params.region);
  return region ? `https://${region}.tts.speech.microsoft.com` : undefined;
}

function azureSpeechUrl(params: {
  baseUrl?: string;
  endpoint?: string;
  region?: string;
  path: "/cognitiveservices/v1" | "/cognitiveservices/voices/list";
}): string {
  const baseUrl = normalizeAzureSpeechBaseUrl(params);
  if (!baseUrl) {
    throw new Error("Azure Speech region or endpoint missing");
  }
  return `${baseUrl}${params.path}`;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildAzureSpeechSsml(params: {
  text: string;
  voice: string;
  lang?: string;
}): string {
  const lang = trimToUndefined(params.lang) ?? DEFAULT_AZURE_SPEECH_LANG;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xml:lang="${escapeXmlAttr(lang)}">` +
    `<voice name="${escapeXmlAttr(params.voice)}">${escapeXmlText(params.text)}</voice>` +
    `</speak>`
  );
}

export function inferAzureSpeechFileExtension(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase();
  if (normalized.includes("mp3")) {
    return ".mp3";
  }
  if (normalized.startsWith("ogg-")) {
    return ".ogg";
  }
  if (normalized.startsWith("webm-")) {
    return ".webm";
  }
  if (normalized.startsWith("riff-")) {
    return ".wav";
  }
  if (normalized.startsWith("raw-")) {
    return ".pcm";
  }
  if (normalized.startsWith("amr-")) {
    return ".amr";
  }
  return ".audio";
}

export function isAzureSpeechVoiceCompatible(outputFormat: string): boolean {
  const normalized = outputFormat.toLowerCase();
  return normalized.startsWith("ogg-") && normalized.includes("opus");
}

function formatVoiceDescription(entry: AzureSpeechVoiceEntry): string | undefined {
  const parts = [
    ...(entry.VoiceTag?.TailoredScenarios ?? []),
    ...(entry.VoiceTag?.VoicePersonalities ?? []),
  ].filter((value) => trimToUndefined(value) !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function isDeprecatedVoice(entry: AzureSpeechVoiceEntry): boolean {
  if (entry.IsDeprecated === true) {
    return true;
  }
  if (typeof entry.IsDeprecated === "string" && entry.IsDeprecated.toLowerCase() === "true") {
    return true;
  }
  const status = trimToUndefined(entry.Status)?.toLowerCase();
  return status === "deprecated" || status === "retired" || status === "disabled";
}

export async function listAzureSpeechVoices(params: {
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
  region?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const url = azureSpeechUrl({ ...params, path: "/cognitiveservices/voices/list" });
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": params.apiKey,
      },
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
    auditContext: "azure-speech.voices",
  });

  try {
    await assertOkOrThrowProviderError(response, "Azure Speech voices API error");
    const voices = (await response.json()) as AzureSpeechVoiceEntry[];
    return Array.isArray(voices)
      ? voices
          .filter((voice) => !isDeprecatedVoice(voice))
          .map((voice) => ({
            id: trimToUndefined(voice.ShortName) ?? "",
            name: trimToUndefined(voice.DisplayName) ?? trimToUndefined(voice.LocalName),
            description: formatVoiceDescription(voice),
            locale: trimToUndefined(voice.Locale),
            gender: trimToUndefined(voice.Gender),
            personalities: voice.VoiceTag?.VoicePersonalities?.filter(
              (value): value is string => trimToUndefined(value) !== undefined,
            ),
          }))
          .filter((voice) => voice.id.length > 0)
      : [];
  } finally {
    await release();
  }
}

export async function azureSpeechTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
  region?: string;
  voice?: string;
  lang?: string;
  outputFormat?: string;
  timeoutMs?: number;
}): Promise<Buffer> {
  const voice = trimToUndefined(params.voice) ?? DEFAULT_AZURE_SPEECH_VOICE;
  const outputFormat = trimToUndefined(params.outputFormat) ?? DEFAULT_AZURE_SPEECH_AUDIO_FORMAT;
  const url = azureSpeechUrl({ ...params, path: "/cognitiveservices/v1" });
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "Ocp-Apim-Subscription-Key": params.apiKey,
        "X-Microsoft-OutputFormat": outputFormat,
        "User-Agent": "OpenClaw",
      },
      body: buildAzureSpeechSsml({
        text: params.text,
        voice,
        lang: params.lang,
      }),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
    auditContext: "azure-speech.tts",
  });

  try {
    await assertOkOrThrowProviderError(response, "Azure Speech TTS API error");
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
