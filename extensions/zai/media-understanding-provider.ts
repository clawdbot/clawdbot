import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const zaiMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "zai",
  capabilities: ["image"],
  defaultModels: { image: "glm-4.6v" },
  autoPriority: { image: 60 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
