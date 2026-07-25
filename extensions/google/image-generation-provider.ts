// Google provider module implements model/runtime integration.
import {
  generatedImageAssetFromBase64,
  resolveInlineImageJsonResponseMaxBytes,
  type GeneratedImageAsset,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { MAX_IMAGE_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  hasConfiguredSecretInput,
  isProviderApiKeyConfigured,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  readProviderJsonResponse,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeGoogleModelId, resolveGoogleGenerativeAiHttpRequestConfig } from "./api.js";

const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image";
const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_OUTPUT_MIME = "image/png";
const GOOGLE_MAX_IMAGE_RESULTS = 4;
const MB = 1024 * 1024;
const GOOGLE_SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
] as const;
const GOOGLE_SUPPORTED_ASPECT_RATIOS = [
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

const GOOGLE_IMAGE_MALFORMED_RESPONSE = "Google image generation response malformed";

function normalizeGoogleImageModel(model: string | undefined): string {
  const trimmed = model?.trim();
  return normalizeGoogleModelId(trimmed || DEFAULT_GOOGLE_IMAGE_MODEL);
}

function resolveGeneratedImageMaxBytes(req: {
  cfg: { agents?: { defaults?: { mediaMaxMb?: number } } };
}): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * MB);
  }
  return MAX_IMAGE_BYTES;
}

function mapSizeToImageConfig(
  size: string | undefined,
): { aspectRatio?: string; imageSize?: "2K" | "4K" } | undefined {
  const trimmed = size?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  const mapping = new Map<string, string>([
    ["1024x1024", "1:1"],
    ["1024x1536", "2:3"],
    ["1536x1024", "3:2"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
  ]);
  const aspectRatio = mapping.get(normalized);

  const [widthRaw, heightRaw] = normalized.split("x");
  const width = parseStrictPositiveInteger(widthRaw);
  const height = parseStrictPositiveInteger(heightRaw);
  if (width === undefined || height === undefined) {
    return undefined;
  }
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;

  if (!aspectRatio && !imageSize) {
    return undefined;
  }

  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

function googleResponseParts(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  const candidates = payload.candidates;
  if (candidates === undefined || candidates === null) {
    return [];
  }
  if (!Array.isArray(candidates)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }

  const parts: unknown[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const content = candidate.content;
    if (content === undefined || content === null) {
      continue;
    }
    if (!isRecord(content)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const candidateParts = content.parts;
    if (candidateParts === undefined || candidateParts === null) {
      continue;
    }
    if (!Array.isArray(candidateParts)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    parts.push(...candidateParts);
  }
  return parts;
}

function googleInlineDataFromPart(part: unknown): Record<string, unknown> | undefined {
  if (!isRecord(part)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  const inline = part.inlineData ?? part.inline_data;
  if (inline === undefined || inline === null) {
    return undefined;
  }
  if (!isRecord(inline)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  return inline;
}

export function buildGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_IMAGE_MODEL,
    models: [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image"],
    isConfigured: ({ cfg, agentDir }) =>
      // generateImage already authenticates from a config apiKey; count a
      // usable one (non-blank literal or secret ref) as configured here too,
      // so image gen works from config alone, like chat.
      hasConfiguredSecretInput(cfg?.models?.providers?.google?.apiKey) ||
      isProviderApiKeyConfigured({
        provider: "google",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: GOOGLE_MAX_IMAGE_RESULTS,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: GOOGLE_MAX_IMAGE_RESULTS,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: [...GOOGLE_SUPPORTED_SIZES],
        aspectRatios: [...GOOGLE_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const model = normalizeGoogleImageModel(req.model);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveGoogleGenerativeAiHttpRequestConfig({
          apiKey: auth.apiKey,
          baseUrl: req.cfg?.models?.providers?.google?.baseUrl,
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg?.models?.providers?.google?.request,
          ),
          capability: "image",
          transport: "http",
        });
      const imageConfig = mapSizeToImageConfig(req.size);
      const inputParts = (req.inputImages ?? []).map((image) => ({
        inlineData: {
          mimeType: image.mimeType,
          data: image.buffer.toString("base64"),
        },
      }));
      const resolvedImageConfig = {
        ...imageConfig,
        ...(req.aspectRatio?.trim() ? { aspectRatio: req.aspectRatio.trim() } : {}),
        ...(req.resolution ? { imageSize: req.resolution } : {}),
      };

      const { response: res, release } = await postJsonRequest({
        url: `${baseUrl}/models/${model}:generateContent`,
        headers,
        body: {
          contents: [
            {
              role: "user",
              parts: [...inputParts, { text: req.prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(Object.keys(resolvedImageConfig).length > 0
              ? { imageConfig: resolvedImageConfig }
              : {}),
          },
        },
        timeoutMs: req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
        fetchFn: fetch,
        pinDns: false,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(res, "Google image generation failed");

        const payload = await readProviderJsonResponse(res, "google.image-generation", {
          maxBytes: resolveInlineImageJsonResponseMaxBytes(
            GOOGLE_MAX_IMAGE_RESULTS,
            resolveGeneratedImageMaxBytes(req),
          ),
        });
        let imageIndex = 0;
        const images: GeneratedImageAsset[] = [];
        for (const part of googleResponseParts(payload)) {
          const inline = googleInlineDataFromPart(part);
          if (!inline) {
            continue;
          }
          const data = normalizeOptionalString(inline.data);
          if (!data) {
            throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
          }
          const image = generatedImageAssetFromBase64({
            base64: data,
            index: imageIndex,
            mimeType:
              normalizeOptionalString(inline.mimeType) ??
              normalizeOptionalString(inline.mime_type) ??
              DEFAULT_OUTPUT_MIME,
          });
          if (!image) {
            throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
          }
          imageIndex += 1;
          images.push(image);
        }

        if (images.length === 0) {
          throw new Error("Google image generation response missing image data");
        }

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
