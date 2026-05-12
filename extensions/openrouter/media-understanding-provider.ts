import path from "node:path";
import {
  describeImageWithModel,
  describeImagesWithModel,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
const SUPPORTED_AUDIO_FORMATS = new Set(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);

function normalizeMimeType(mime?: string): string | undefined {
  const normalized = mime?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const [type] = normalized.split(";");
  const clean = type?.trim();
  return clean || undefined;
}

function resolveFormatFromMime(mime?: string): string | undefined {
  const normalized = normalizeMimeType(mime);
  if (!normalized) {
    return undefined;
  }
  switch (normalized) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/flac":
      return "flac";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
    case "audio/oga":
    case "audio/opus":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/aac":
      return "aac";
    default:
      return undefined;
  }
}

function resolveFormatFromFileName(fileName?: string): string | undefined {
  const ext = path
    .extname(fileName ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!ext) {
    return undefined;
  }
  if (ext === "mpeg") {
    return "mp3";
  }
  if (ext === "mp4") {
    return "m4a";
  }
  if (ext === "oga" || ext === "opus") {
    return "ogg";
  }
  return SUPPORTED_AUDIO_FORMATS.has(ext) ? ext : undefined;
}

function resolveOpenRouterAudioFormat(params: { mime?: string; fileName?: string }): string {
  const fromMime = resolveFormatFromMime(params.mime);
  if (fromMime) {
    return fromMime;
  }
  const fromFileName = resolveFormatFromFileName(params.fileName);
  if (fromFileName) {
    return fromFileName;
  }
  throw new Error(
    `OpenRouter STT could not resolve audio format from mime "${params.mime ?? ""}" and file "${params.fileName ?? ""}"`,
  );
}

type OpenRouterSttResponse = {
  text?: string;
};

export async function transcribeOpenRouterAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const model = params.model?.trim() || DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL;
  const format = resolveOpenRouterAudioFormat({
    mime: params.mime,
    fileName: params.fileName,
  });
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: OPENROUTER_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      provider: "openrouter",
      api: "openrouter-stt",
      capability: "audio",
      transport: "media-understanding",
    });

  const { response, release } = await postJsonRequest({
    url: `${baseUrl}/audio/transcriptions`,
    headers,
    body: {
      model,
      input_audio: {
        data: params.buffer.toString("base64"),
        format,
      },
      ...(params.language?.trim() ? { language: params.language.trim() } : {}),
      ...(typeof params.query?.temperature === "number"
        ? { temperature: params.query.temperature }
        : {}),
    },
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "openrouter stt",
  });

  try {
    await assertOkOrThrowHttpError(response, "OpenRouter audio transcription failed");
    const payload = (await response.json()) as OpenRouterSttResponse;
    return {
      text: requireTranscriptionText(
        payload.text,
        "OpenRouter transcription response missing text",
      ),
      model,
    };
  } finally {
    await release();
  }
}

export const openrouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openrouter",
  capabilities: ["image", "audio"],
  defaultModels: {
    image: "auto",
    audio: DEFAULT_OPENROUTER_AUDIO_TRANSCRIPTION_MODEL,
  },
  autoPriority: {
    audio: 35,
  },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenRouterAudio,
};
