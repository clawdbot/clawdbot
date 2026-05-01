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
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { MOONSHOT_DEFAULT_MODEL_ID } from "./provider-catalog.js";

const DEFAULT_MOONSHOT_VIDEO_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MOONSHOT_VIDEO_MODEL = MOONSHOT_DEFAULT_MODEL_ID;
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";

export async function describeMoonshotVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_MOONSHOT_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_MOONSHOT_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: DEFAULT_MOONSHOT_VIDEO_BASE_URL,
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
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Moonshot video description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
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
  defaultModels: { image: MOONSHOT_DEFAULT_MODEL_ID, video: DEFAULT_MOONSHOT_VIDEO_MODEL },
  autoPriority: { video: 20 },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  describeVideo: describeMoonshotVideo,
};
