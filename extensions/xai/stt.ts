// Xai plugin module implements stt behavior.
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonResponse,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";

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

  const language = normalizeOptionalString(params.language);
  const form = buildAudioTranscriptionFormData({
    buffer: params.buffer,
    fileName: params.fileName,
    mime: params.mime,
    fields: {
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
    const payload = await readProviderJsonResponse<XaiSttResponse>(response, "xai.stt");
    return {
      text: requireTranscriptionText(payload.text, "xAI transcription response missing text"),
    };
  } finally {
    await release();
  }
}

export function buildXaiMediaUnderstandingProvider(): MediaUnderstandingProvider {
  // Auth is resolved by media-understanding core via resolveProviderExecutionContext
  // before transcribeAudio runs, so an OAuth profile (when configured) reaches
  // here as `params.apiKey` already. No plugin-side fallback required.
  return {
    id: "xai",
    capabilities: ["audio"],
    autoPriority: { audio: 25 },
    transcribeAudio: transcribeXaiAudio,
  };
}
