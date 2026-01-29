import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { fetchWithTimeout, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_SMALLEST_AUDIO_BASE_URL = "https://waves-api.smallest.ai/api/v1";
export const DEFAULT_SMALLEST_AUDIO_MODEL = "pulse"; // Smallest AI Pulse STT model

type SmallestTranscriptResponse = {
  status?: string;
  transcription?: string;
  text?: string;
  audio_length?: number;
  metadata?: {
    duration?: number;
    fileSize?: number;
  };
};

/**
 * Transcribe audio using Smallest AI's Pulse STT API.
 *
 * Endpoint: POST /api/v1/pulse/get_text
 * Uses raw audio bytes with Content-Type header (application/octet-stream method).
 * @see https://waves-docs.smallest.ai/v4.0.0/content/api-references/pulse-stt
 */
export async function transcribeSmallestAiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_SMALLEST_AUDIO_BASE_URL);

  // Build query parameters
  const queryParams = new URLSearchParams();
  queryParams.set("model", "pulse");
  if (params.language?.trim()) {
    queryParams.set("language", params.language.trim());
  } else {
    queryParams.set("language", "en");
  }

  // Pulse API endpoint for STT with query params
  const url = `${baseUrl}/pulse/get_text?${queryParams.toString()}`;

  // Determine content type from mime or default to audio/wav
  const contentType = params.mime ?? "audio/wav";

  // Send raw audio bytes directly (application/octet-stream method)
  const headers = new Headers(params.headers);
  headers.set("Content-Type", contentType);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  // Convert Buffer to Uint8Array for fetch body
  const audioBytes = new Uint8Array(params.buffer);

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: audioBytes,
    },
    params.timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    const detail = await readErrorResponse(res);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Smallest AI Pulse STT failed (HTTP ${res.status})${suffix}`);
  }

  const payload = (await res.json()) as SmallestTranscriptResponse;
  const transcript = (payload.transcription ?? payload.text)?.trim();
  if (!transcript) {
    throw new Error("Smallest AI Pulse STT response missing transcription");
  }
  return { text: transcript, model: "pulse" };
}
