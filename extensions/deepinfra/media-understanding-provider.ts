import {
  describeImageWithModel,
  describeImagesWithModel,
  transcribeOpenAiCompatibleAudio,
  type AudioTranscriptionRequest,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import {
  DEEPINFRA_BASE_URL,
  DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL,
  DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL,
} from "./media-models.js";

export async function transcribeDeepInfraAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "deepinfra",
    defaultBaseUrl: DEEPINFRA_BASE_URL,
    defaultModel: DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL,
  });
}

export const deepinfraMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "deepinfra",
  capabilities: ["image", "audio"],
  defaultModels: {
    image: DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL,
    audio: DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL,
  },
  autoPriority: {
    image: 45,
    audio: 45,
  },
  transcribeAudio: transcribeDeepInfraAudio,
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
