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
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createXaiMediaUnderstandingProviderMetadata } from "./capability-provider-metadata.js";
import { XAI_BASE_URL } from "./model-definitions.js";

function resolveXaiSttBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

async function transcribeXaiAudio(
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
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "xai stt",
  });

  try {
    await assertOkOrThrowHttpError(response, "xAI audio transcription failed");
    const payload = await readProviderJsonObjectResponse(response, "xai.stt");
    if (typeof payload.text !== "string") {
      throw new Error("xAI transcription response missing text");
    }
    // xAI returns an empty transcript for valid audio without detected speech.
    return { text: payload.text.trim() };
  } finally {
    await release();
  }
}

export function buildXaiMediaUnderstandingProvider(): MediaUnderstandingProvider {
  // Auth is resolved by media-understanding core via resolveProviderExecutionContext
  // before transcribeAudio runs, so an OAuth profile (when configured) reaches
  // here as `params.apiKey` already. No plugin-side fallback required.
  return {
    ...createXaiMediaUnderstandingProviderMetadata(),
    transcribeAudio: transcribeXaiAudio,
  };
}
