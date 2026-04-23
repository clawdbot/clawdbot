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
import { DEFAULT_ELEVENLABS_BASE_URL, normalizeElevenLabsBaseUrl } from "./shared.js";

const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v2";

export async function transcribeElevenLabsAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const apiKey = req.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs API key missing");
  }

  const model = req.model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeElevenLabsBaseUrl(req.baseUrl),
      defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
      headers: req.headers,
      request: req.request,
      defaultHeaders: {
        "xi-api-key": apiKey,
      },
      provider: "elevenlabs",
      api: "elevenlabs-speech-to-text",
      capability: "audio",
      transport: "media-understanding",
    });
  const form = buildAudioTranscriptionFormData({
    buffer: req.buffer,
    fileName: req.fileName,
    mime: req.mime,
    fields: {
      model_id: model,
      language_code: req.language,
      prompt: req.prompt,
    },
  });
  const { response, release } = await postTranscriptionRequest({
    url: `${baseUrl}/v1/speech-to-text`,
    headers,
    body: form,
    timeoutMs: req.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: "elevenlabs speech-to-text",
  });

  try {
    await assertOkOrThrowHttpError(response, "ElevenLabs audio transcription failed");
    const payload = (await response.json()) as { text?: string };
    const text = requireTranscriptionText(
      payload.text,
      "ElevenLabs audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}

export const elevenLabsMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "elevenlabs",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_ELEVENLABS_STT_MODEL },
  autoPriority: { audio: 45 },
  transcribeAudio: transcribeElevenLabsAudio,
};
