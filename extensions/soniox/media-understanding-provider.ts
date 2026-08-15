/**
 * Soniox media-understanding provider module implements audio transcription.
 */
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { transcribeSonioxAudio } from "./audio.js";

export const sonioxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "soniox",
  capabilities: ["audio"],
  defaultModels: { audio: "stt-async-v5" },
  autoPriority: { audio: 30 },
  transcribeAudio: transcribeSonioxAudio,
};
