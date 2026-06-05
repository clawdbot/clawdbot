/**
 * Anthropic media-understanding provider descriptor. It routes image and native
 * document description through the shared model-backed media helpers.
 */
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

/** Media-understanding provider for Anthropic Claude models. */
export const anthropicMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "anthropic",
  capabilities: ["image"],
  defaultModels: { image: "claude-opus-4-8" },
  autoPriority: { image: 20 },
  nativeDocumentInputs: ["pdf"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
