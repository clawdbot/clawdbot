import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { OLLAMA_PROVIDER_ID } from "./discovery-shared.js";

// Ollama vision support depends on which models the user has pulled (llava,
// qwen2.5vl, llama3.2-vision, …) — there is no single canonical default. We
// register the provider so the image tool can route `ollama/<vision-model>`
// requests, but leave `defaultModels` and `autoPriority` unset so Ollama
// only participates when the user explicitly configures an image model.
export const ollamaMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: OLLAMA_PROVIDER_ID,
  capabilities: ["image"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
