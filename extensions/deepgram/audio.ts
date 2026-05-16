import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";

export const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
export const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_DEEPGRAM_AUDIO_MODEL;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readDeepgramTranscript(payload: Record<string, unknown>): string | undefined {
  const results = asRecord(payload.results);
  if (!results) {
    return undefined;
  }
  if (!Array.isArray(results.channels)) {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  const channel = asRecord(results.channels[0]);
  if (!channel) {
    return undefined;
  }
  if (!Array.isArray(channel.alternatives)) {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  const alternative = asRecord(channel.alternatives[0]);
  if (!alternative) {
    return undefined;
  }
  if (alternative.transcript !== undefined && typeof alternative.transcript !== "string") {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  return alternative.transcript;
}

export async function transcribeDeepgramAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveModel(params.model);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: DEFAULT_DEEPGRAM_AUDIO_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        authorization: `Token ${params.apiKey}`,
        "content-type": params.mime ?? "application/octet-stream",
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

  const url = new URL(`${baseUrl}/listen`);
  url.searchParams.set("model", model);
  if (params.language?.trim()) {
    url.searchParams.set("language", params.language.trim());
  }
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  const body = new Uint8Array(params.buffer);
  const { response: res, release } = await postTranscriptionRequest({
    url: url.toString(),
    headers,
    body,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = await readProviderJsonObjectResponse(res, "Audio transcription failed");
    const transcript = requireTranscriptionText(
      readDeepgramTranscript(payload),
      "Audio transcription response missing transcript",
    );
    return { text: transcript, model };
  } finally {
    await release();
  }
}
