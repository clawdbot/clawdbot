import type { MediaUnderstandingCapability } from "./types.js";

// Shared API contract id for OpenAI-compatible /audio/transcriptions requests.
export const OPENAI_AUDIO_TRANSCRIPTIONS_API = "openai-audio-transcriptions";

export function resolveOpenAiAudioAuthModelApi(params: {
  capability: MediaUnderstandingCapability;
  providerId: string;
}): string | undefined {
  if (params.capability === "audio" && params.providerId.trim().toLowerCase() === "openai") {
    return OPENAI_AUDIO_TRANSCRIPTIONS_API;
  }
  return undefined;
}
