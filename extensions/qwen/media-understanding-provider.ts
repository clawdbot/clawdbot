// Qwen provider module implements model/runtime integration.
import {
  describeOpenAiCompatibleVideo,
  type MediaUnderstandingProvider,
  type VideoDescriptionRequest,
} from "openclaw/plugin-sdk/media-understanding";
import { QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_MEDIA_MODEL = "qwen3.6-plus";
const DEFAULT_QWEN_VIDEO_PROMPT = "Describe the video in detail.";

function describeQwenVideo(params: VideoDescriptionRequest) {
  return describeOpenAiCompatibleVideo({
    ...params,
    defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
    defaultModel: DEFAULT_QWEN_MEDIA_MODEL,
    defaultPrompt: DEFAULT_QWEN_VIDEO_PROMPT,
    provider: "qwen",
    providerLabel: "Qwen",
  });
}

export function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "qwen",
    capabilities: ["image", "video"],
    defaultModels: {
      image: DEFAULT_QWEN_MEDIA_MODEL,
      video: DEFAULT_QWEN_MEDIA_MODEL,
    },
    autoPriority: {
      video: 15,
    },
    describeImage: undefined,
    describeImages: undefined,
    describeVideo: describeQwenVideo,
  };
}
