// Openai provider module implements model/runtime integration.
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  defaultModels: { image: "gpt-5.6-sol", audio: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL },
  autoPriority: { image: 20, audio: 20 },
  async describeImage(req) {
    const { describeImageWithModel } = await import("openclaw/plugin-sdk/media-understanding");
    return describeImageWithModel(req);
  },
  async describeImages(req) {
    const { describeImagesWithModel } = await import("openclaw/plugin-sdk/media-understanding");
    return describeImagesWithModel(req);
  },
  async transcribeAudio(req) {
    const { transcribeOpenAiAudio } = await import("./audio-transcription.js");
    return transcribeOpenAiAudio(req);
  },
  async transcribeAudioWithContext(context) {
    const { transcribeOpenAiAudioWithContext } = await import("./audio-transcription.js");
    return transcribeOpenAiAudioWithContext(context);
  },
};
