// Gandr plugin module implements tts behavior.
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech-core";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const DEFAULT_GANDR_BASE_URL = "https://tts.gandr.ai/v1";
export const DEFAULT_GANDR_VOICE_ID = "gandr-mia";
export const DEFAULT_GANDR_MODEL_ID = "tts-1";

// The speech endpoint returns raw audio bytes (MP3, WAV, or headerless PCM),
// so the shared 16 MiB audio limit bounds the read directly. This closes an
// otherwise unbounded buffer against a hijacked or misbehaving upstream.
const GANDR_TTS_BODY_MAX_BYTES = MAX_AUDIO_BYTES;
// Abort the read if the upstream stalls mid-body so a hung stream cannot pin
// the socket and buffers open indefinitely.
const GANDR_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;
// Error responses only need a short diagnostic snippet, never the whole body.
const GANDR_ERROR_BODY_MAX_BYTES = 8 * 1024;
const GANDR_ERROR_BODY_MAX_CHARS = 400;
const GANDR_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;

// Gandr rejects synthesis input above 2000 characters per request, so raise
// a clear client-side error instead of a provider 4xx.
export const GANDR_MAX_INPUT_CHARS = 2000;

export const GANDR_TTS_MODELS = ["tts-1"] as const;

// Stock voice catalog. Gandr does not expose a voices listing endpoint, so
// the catalog ships with the provider.
export const GANDR_TTS_VOICE_IDS = [
  "gandr-mia",
  "gandr-ava",
  "gandr-jenny",
  "gandr-dane",
  "gandr-leo",
  "gandr-lewis",
] as const;

export type GandrResponseFormat = "mp3" | "wav" | "pcm";

// PCM output is headerless signed 16-bit little-endian mono at 24000 Hz.
export const GANDR_PCM_SAMPLE_RATE_HERTZ = 24_000;

// Sentinel so the error-snippet reader can tell a cap overflow apart from an
// unrelated read failure without leaking the (possibly hostile) body.
class GandrErrorBodyOverflow extends Error {}

/**
 * Reads a bounded, whitespace-collapsed diagnostic snippet from a non-OK
 * response body. A misbehaving or hostile endpoint can stream an arbitrarily
 * large error body, so this never buffers it whole: it reuses the shared
 * `readResponseWithLimit` reader (which cancels the underlying stream on
 * overflow and enforces an idle timeout) with a small cap. On overflow it
 * returns a fixed marker instead of echoing attacker-controlled bytes into the
 * thrown error. Kept local to this extension so it depends only on the
 * already-exported `response-limit-runtime` entry and adds no shared plugin-SDK
 * surface.
 */
async function readGandrErrorBodySnippet(response: Response): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readResponseWithLimit(response, GANDR_ERROR_BODY_MAX_BYTES, {
      chunkTimeoutMs: GANDR_ERROR_BODY_READ_IDLE_TIMEOUT_MS,
      onOverflow: () => new GandrErrorBodyOverflow(),
    });
  } catch (error) {
    return error instanceof GandrErrorBodyOverflow
      ? "(error body exceeded diagnostic limit; truncated)"
      : "";
  }

  const collapsed = buffer.toString("utf8").replace(/\s+/g, " ").trim();
  if (collapsed.length > GANDR_ERROR_BODY_MAX_CHARS) {
    return `${truncateUtf16Safe(collapsed, GANDR_ERROR_BODY_MAX_CHARS)}…`;
  }
  return collapsed;
}

export function normalizeGandrBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_GANDR_BASE_URL;
}

function ssrfPolicyFromGandrBaseUrl(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { hostnameAllowlist: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

/**
 * Calls the Gandr speech endpoint (OpenAI compatible `/audio/speech`) and
 * returns the response bytes as a single buffer. The endpoint returns raw
 * audio in the requested `response_format` (MP3, WAV, or headerless PCM at
 * 24000 Hz).
 */
export async function gandrTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  modelId?: string;
  responseFormat?: GandrResponseFormat;
  timeoutMs?: number;
}): Promise<Buffer> {
  if (params.text.length > GANDR_MAX_INPUT_CHARS) {
    throw new Error(
      `Gandr TTS input too long: ${params.text.length} chars (limit: ${GANDR_MAX_INPUT_CHARS} chars)`,
    );
  }

  const baseUrl = normalizeGandrBaseUrl(params.baseUrl);
  const url = `${baseUrl}/audio/speech`;
  const requestBody = JSON.stringify({
    model: params.modelId ?? DEFAULT_GANDR_MODEL_ID,
    input: params.text,
    voice: params.voiceId ?? DEFAULT_GANDR_VOICE_ID,
    response_format: params.responseFormat ?? "mp3",
  });

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: requestBody,
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromGandrBaseUrl(baseUrl),
    auditContext: "gandr-tts",
  });

  try {
    if (!response.ok) {
      const errorBody = await readGandrErrorBodySnippet(response);
      throw new Error(`Gandr TTS API error (${response.status}): ${errorBody}`);
    }

    const audioBuffer = await readResponseWithLimit(response, GANDR_TTS_BODY_MAX_BYTES, {
      chunkTimeoutMs: GANDR_UPSTREAM_IDLE_TIMEOUT_MS,
      onOverflow: ({ size, maxBytes }) =>
        new Error(`Gandr TTS audio response too large: ${size} bytes (limit: ${maxBytes} bytes)`),
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`Gandr TTS audio response stalled: no data received for ${chunkTimeoutMs}ms`),
    });

    if (audioBuffer.length === 0) {
      throw new Error("Gandr TTS returned no audio data");
    }

    return audioBuffer;
  } finally {
    await release();
  }
}

/**
 * Returns the stock Gandr voice catalog. Gandr has no voices listing
 * endpoint; the six stock voices are stable identifiers.
 */
export function listGandrVoices(): SpeechVoiceOption[] {
  return GANDR_TTS_VOICE_IDS.map((id) => ({
    id,
    name: id.replace(/^gandr-/, "").replace(/^./, (c) => c.toUpperCase()),
  }));
}
