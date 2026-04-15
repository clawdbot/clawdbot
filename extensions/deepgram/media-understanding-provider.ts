import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { transcribeDeepgramAudio } from "./audio.js";

export const deepgramMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "deepgram",
  capabilities: ["audio"],
  defaultModels: { audio: "nova-3" },
  autoPriority: { audio: 30 },
  transcribeAudio: transcribeDeepgramAudio,
};
