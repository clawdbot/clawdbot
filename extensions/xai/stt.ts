import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";

export const XAI_DEFAULT_STT_MODEL = "grok-stt";

type XaiSttResponse = {
  text?: string;
};

function resolveXaiSttBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

export async function transcribeXaiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: resolveXaiSttBaseUrl(params.baseUrl),
      defaultBaseUrl: XAI_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      provider: "xai",
      api: "xai-stt",
      capability: "audio",
      transport: "media-understanding",
    });

  const model = normalizeOptionalString(params.model);
  const language = normalizeOptionalString(params.language);
  const form = buildAudioTranscriptionFormData({
    buffer: params.buffer,
    fileName: params.fileName,
    mime: params.mime,
    fields: {
      model,
      language,
    },
  });

  const { response, release } = await postTranscriptionRequest({
    url: `${baseUrl}/stt`,
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "xai stt",
  });

  try {
    await assertOkOrThrowHttpError(response, "xAI audio transcription failed");
    const payload = (await response.json()) as XaiSttResponse;
    return {
      text: requireTranscriptionText(payload.text, "xAI transcription response missing text"),
      ...(model ? { model } : {}),
    };
  } finally {
    await release();
  }
}

export function buildXaiMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "xai",
    capabilities: ["audio"],
    defaultModels: { audio: XAI_DEFAULT_STT_MODEL },
    autoPriority: { audio: 25 },
    transcribeAudio: transcribeXaiAudio,
  };
}
