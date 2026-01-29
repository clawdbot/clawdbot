import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeSmallestAiAudio } from "./audio.js";

export const smallestaiProvider: MediaUnderstandingProvider = {
  id: "smallestai",
  capabilities: ["audio"],
  transcribeAudio: transcribeSmallestAiAudio,
};
