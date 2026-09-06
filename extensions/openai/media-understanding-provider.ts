// Openai provider module implements model/runtime integration.
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { transcribeOpenAiAudioWithContext, transcribeOpenAiAudio } from "./audio-transcription.js";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  defaultModels: { image: "gpt-5.6-sol", audio: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL },
  autoPriority: { image: 20, audio: 20 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenAiAudio,
  transcribeAudioWithContext: transcribeOpenAiAudioWithContext,
};
