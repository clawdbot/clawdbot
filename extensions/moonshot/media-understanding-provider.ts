// Moonshot provider module implements model/runtime integration.
import {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  describeImageWithModel,
  describeImagesWithModel,
  resolveMediaUnderstandingString,
  type MediaUnderstandingProvider,
  type OpenAiCompatibleVideoPayload,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { MOONSHOT_BASE_URL } from "./provider-catalog.js";

// Media defaults are capability-specific and intentionally independent from chat onboarding.
const DEFAULT_MOONSHOT_IMAGE_MODEL =
  manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.image;
const DEFAULT_MOONSHOT_VIDEO_MODEL =
  manifest.mediaUnderstandingProviderMetadata.moonshot.defaultModels.video;
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";

async function describeMoonshotVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_MOONSHOT_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_MOONSHOT_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: MOONSHOT_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "moonshot",
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });
  const url = `${baseUrl}/chat/completions`;

  const body = buildOpenAiCompatibleVideoRequestBody({
    model,
    prompt,
    mime,
    buffer: params.buffer,
  });

  const { response: res, release } = await postJsonRequest({
    url,
    headers,
    body,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Moonshot video description failed");
    const payload = await readProviderJsonResponse<OpenAiCompatibleVideoPayload>(
      res,
      "Moonshot video description failed",
    );
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Moonshot video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export const moonshotMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "moonshot",
  capabilities: ["image", "video"],
  defaultModels: {
    image: DEFAULT_MOONSHOT_IMAGE_MODEL,
    video: DEFAULT_MOONSHOT_VIDEO_MODEL,
  },
  autoPriority: { video: 20 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  describeVideo: describeMoonshotVideo,
};
