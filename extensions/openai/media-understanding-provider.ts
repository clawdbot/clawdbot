import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "openai",
    defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  });
}

export async function transcribeOpenAiCodexAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "openai-codex",
    defaultBaseUrl: DEFAULT_OPENAI_AUDIO_BASE_URL,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  });
}

export const openaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  defaultModels: {
    image: "gpt-5.4-mini",
    audio: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  },
  autoPriority: { image: 10, audio: 10 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenAiAudio,
};

export const openaiCodexMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "openai-codex",
  capabilities: ["image", "audio"],
  defaultModels: { image: "gpt-5.5", audio: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL },
  autoPriority: { image: 20, audio: 20 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  transcribeAudio: transcribeOpenAiCodexAudio,
};
