import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import {
  generatedImageAssetFromBase64,
  generatedImageAssetFromDataUrl,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_RESULTS = 4;
const SUPPORTED_MODELS = [
  DEFAULT_MODEL,
  "google/gemini-3-pro-image-preview",
  "openai/gpt-5.4-image-2",
] as const;
const SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
const OPENROUTER_IMAGE_MALFORMED_RESPONSE = "OpenRouter image generation response malformed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function throwMalformedOpenRouterImageResponse(message: string | undefined): never | undefined {
  if (message) {
    throw new Error(message);
  }
  return undefined;
}

function pushDataUrlImage(
  images: GeneratedImageAsset[],
  dataUrl: string,
  malformedResponseError?: string,
): void {
  const image = generatedImageAssetFromDataUrl({ dataUrl, index: images.length });
  if (!image) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  images.push(image);
}

function extractImagesFromPart(
  images: GeneratedImageAsset[],
  part: unknown,
  malformedResponseError?: string,
): void {
  if (!isRecord(part)) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  if (part.type === "text") {
    return;
  }
  if (part.type === "image_url") {
    const imageUrl = part.image_url ?? part.imageUrl;
    if (!isRecord(imageUrl)) {
      throwMalformedOpenRouterImageResponse(malformedResponseError);
      return;
    }
    const url = normalizeOptionalString(imageUrl.url);
    if (url) {
      pushDataUrlImage(images, url, malformedResponseError);
      return;
    }
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }

  const rawBase64 = normalizeOptionalString(part.b64_json);
  if (rawBase64) {
    const image = generatedImageAssetFromBase64({ base64: rawBase64, index: images.length });
    if (image) {
      images.push(image);
      return;
    }
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  if ("b64_json" in part) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }

  const inlineData = part.inlineData ?? part.inline_data;
  if (inlineData === undefined || inlineData === null) {
    return;
  }
  if (!isRecord(inlineData)) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  const data = normalizeOptionalString(inlineData.data);
  if (!data) {
    throwMalformedOpenRouterImageResponse(malformedResponseError);
    return;
  }
  const mimeType =
    normalizeOptionalString(inlineData.mimeType) ??
    normalizeOptionalString(inlineData.mime_type) ??
    "image/png";
  const image = generatedImageAssetFromBase64({
    base64: data,
    index: images.length,
    mimeType,
  });
  if (image) {
    images.push(image);
    return;
  }
  throwMalformedOpenRouterImageResponse(malformedResponseError);
}

export function extractOpenRouterImagesFromResponse(
  body: unknown,
  options: { malformedResponseError?: string } = {},
): GeneratedImageAsset[] {
  if (!isRecord(body)) {
    throwMalformedOpenRouterImageResponse(options.malformedResponseError);
    return [];
  }
  const choices = body.choices;
  if (choices === undefined || choices === null) {
    return [];
  }
  if (!Array.isArray(choices)) {
    throwMalformedOpenRouterImageResponse(options.malformedResponseError);
    return [];
  }

  const images: GeneratedImageAsset[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      throwMalformedOpenRouterImageResponse(options.malformedResponseError);
      continue;
    }
    const message = choice.message;
    if (message === undefined || message === null) {
      continue;
    }
    if (!isRecord(message)) {
      throwMalformedOpenRouterImageResponse(options.malformedResponseError);
      continue;
    }

    const messageImages = message.images;
    if (messageImages !== undefined && messageImages !== null) {
      if (!Array.isArray(messageImages)) {
        throwMalformedOpenRouterImageResponse(options.malformedResponseError);
        continue;
      }
      for (const entry of messageImages) {
        if (!isRecord(entry)) {
          throwMalformedOpenRouterImageResponse(options.malformedResponseError);
          continue;
        }
        const imageUrl = entry.image_url ?? entry.imageUrl;
        if (!isRecord(imageUrl)) {
          throwMalformedOpenRouterImageResponse(options.malformedResponseError);
          continue;
        }
        const url = normalizeOptionalString(imageUrl.url);
        if (!url) {
          throwMalformedOpenRouterImageResponse(options.malformedResponseError);
          continue;
        }
        pushDataUrlImage(images, url, options.malformedResponseError);
      }
    }

    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      const dataUrlPattern = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g;
      for (const match of content.matchAll(dataUrlPattern)) {
        pushDataUrlImage(images, match[0]);
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        extractImagesFromPart(images, part, options.malformedResponseError);
      }
    } else if (content !== undefined && content !== null) {
      throwMalformedOpenRouterImageResponse(options.malformedResponseError);
    }
  }
  return images;
}

function resolveImageCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return 1;
  }
  return Math.max(1, Math.min(MAX_IMAGE_RESULTS, Math.trunc(count)));
}

function isGeminiImageModel(model: string): boolean {
  return model.startsWith("google/gemini-");
}

function buildMessageContent(
  req: ImageGenerationRequest,
):
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const inputImages = req.inputImages ?? [];
  if (inputImages.length === 0) {
    return req.prompt;
  }
  return [
    { type: "text", text: req.prompt },
    ...inputImages.map((image) => ({
      type: "image_url" as const,
      image_url: { url: toImageDataUrl(image) },
    })),
  ];
}

function buildImageConfig(req: ImageGenerationRequest, model: string): Record<string, string> {
  if (!isGeminiImageModel(model)) {
    return {};
  }
  const imageConfig: Record<string, string> = {};
  const aspectRatio = normalizeOptionalString(req.aspectRatio);
  if (aspectRatio) {
    imageConfig.aspect_ratio = aspectRatio;
  }
  const resolution = normalizeOptionalString(req.resolution);
  if (resolution) {
    imageConfig.image_size = resolution;
  }
  return imageConfig;
}

export function buildOpenRouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
    models: [...SUPPORTED_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: "openrouter", agentDir }),
    capabilities: {
      generate: {
        maxCount: MAX_IMAGE_RESULTS,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: MAX_IMAGE_RESULTS,
        maxInputImages: 5,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const model = normalizeOptionalString(req.model) ?? DEFAULT_MODEL;
      const imageConfig = buildImageConfig(req, model);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: req.cfg?.models?.providers?.openrouter?.baseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          provider: "openrouter",
          capability: "image",
          transport: "http",
        });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/chat/completions`,
        headers,
        body: {
          model,
          messages: [{ role: "user", content: buildMessageContent(req) }],
          modalities: ["image", "text"],
          n: resolveImageCount(req.count),
          ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
        },
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchFn: fetch,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter image generation failed");
        const payload = await response.json();
        const images = extractOpenRouterImagesFromResponse(payload, {
          malformedResponseError: OPENROUTER_IMAGE_MALFORMED_RESPONSE,
        });
        if (images.length === 0) {
          throw new Error("OpenRouter image generation response missing image data");
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}
