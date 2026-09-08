// Gandr plugin module holds the provider constants and the stock voice catalog.
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";

export const DEFAULT_GANDR_BASE_URL = "https://tts.gandr.ai/v1";
export const DEFAULT_GANDR_VOICE_ID = "gandr-mia";
export const DEFAULT_GANDR_MODEL_ID = "tts-1";

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

// Attachments pick a compressed format; telephony always requests headerless PCM.
export const GANDR_TTS_RESPONSE_FORMATS = ["mp3", "wav", "pcm"] as const;
export type GandrResponseFormat = (typeof GANDR_TTS_RESPONSE_FORMATS)[number];

// PCM output is headerless signed 16-bit little-endian mono at 24000 Hz.
export const GANDR_PCM_SAMPLE_RATE_HERTZ = 24_000;

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
