// OpenAI-compatible audio transcription adapter for providers exposing the
// /audio/transcriptions API shape.
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "./shared.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "./types.js";

type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
  provider?: string;
};

// Shared implementation for OpenAI-style /audio/transcriptions providers.
function resolveModel(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  return trimmed || fallback;
}

/** Sends an OpenAI-compatible audio transcription request and returns validated text output. */
export async function transcribeOpenAiCompatibleAudio(
  params: OpenAiCompatibleAudioParams,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const apiKey = params.auth?.kind === "api-key" ? params.auth.apiKey : params.apiKey;
  // Explicit auth:none suppresses bearer headers even if legacy apiKey params are present.
  const defaultHeaders =
    params.auth?.kind === "none" || !apiKey
      ? undefined
      : {
          authorization: `Bearer ${apiKey}`,
        };
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: params.defaultBaseUrl,
      headers: params.headers,
      request: params.request,
      defaultHeaders,
      provider: params.provider,
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model, params.defaultModel);
  // Keep multipart construction centralized so provider tests cover filename and MIME behavior.
  const form = buildAudioTranscriptionFormData({
    buffer: params.buffer,
    fileName: params.fileName,
    mime: params.mime,
    fields: {
      model,
      language: params.language,
      prompt: params.prompt,
    },
  });

  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    pinDns: false,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = await readProviderJsonObjectResponse(res, "Audio transcription failed");
    const text = requireTranscriptionText(
      typeof payload.text === "string" ? payload.text : undefined,
      "Audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}
