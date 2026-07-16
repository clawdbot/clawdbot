import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax",
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  autoPriority: { image: 40 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax-portal",
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  autoPriority: { image: 50 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
