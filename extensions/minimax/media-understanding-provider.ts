// Minimax provider module implements model/runtime integration.
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";

export const minimaxMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax",
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
  autoPriority: { image: 40 },
  describeImage: undefined,
  describeImages: undefined,
};

export const minimaxPortalMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "minimax-portal",
  capabilities: ["image"],
  defaultModels: { image: "MiniMax-VL-01" },
  documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
  autoPriority: { image: 50 },
  describeImage: undefined,
  describeImages: undefined,
};
