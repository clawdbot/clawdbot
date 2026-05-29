import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import {
  imageFileExtensionForMimeType,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
  mergeSsrFPolicies,
  type SsrFPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFalHttpRequestConfig } from "./http-config.js";

const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux/dev";
const DEFAULT_FAL_EDIT_SUBPATH = "image-to-image";
const FAL_KREA_2_MODEL_PREFIX = "krea/v2/";
const FAL_KREA_2_MEDIUM_MODEL = "krea/v2/medium/text-to-image";
const FAL_KREA_2_LARGE_MODEL = "krea/v2/large/text-to-image";
const DEFAULT_OUTPUT_FORMAT = "png";
const GPT_IMAGE_EDIT_MAX_INPUT_IMAGES = 10;
const NANO_BANANA_EDIT_MAX_INPUT_IMAGES = 14;
const KREA_STYLE_REFERENCE_MAX_INPUT_IMAGES = 10;
const FAL_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const FAL_SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
] as const;
const FAL_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "2.35:1",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
] as const;
const KREA_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:2",
  "16:9",
  "2.35:1",
  "4:5",
  "2:3",
  "9:16",
] as const;
const NANO_BANANA_SUPPORTED_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
] as const;
const KREA_CREATIVITY_LEVELS = ["raw", "low", "medium", "high"] as const;

const FAL_IMAGE_MALFORMED_RESPONSE = "fal image generation response malformed";

type FalImageSize = string | { width: number; height: number };
type FalImageModelSchema = {
  geometry: "image_size" | "native_aspect_ratio";
  aspectRatios?: readonly string[];
  referenceImages: "image_url" | "image_urls" | "image_style_references";
  maxInputImages: number;
  referenceLimitLabel: string;
  referenceLimitNoun: "reference image" | "style reference";
  appendEditPath: false | "edit" | "image-to-image";
  supportsCount: boolean;
  supportsOutputFormat: boolean;
  defaultBody?: Record<string, unknown>;
};
type FalNetworkPolicy = {
  apiPolicy?: SsrFPolicy;
  trustedDownloadHostSuffix?: string;
  trustedDownloadPolicy?: SsrFPolicy;
};

let falFetchGuard = fetchWithSsrFGuard;

export function setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  falFetchGuard = impl ?? fetchWithSsrFGuard;
}

function matchesTrustedHostSuffix(hostname: string, trustedSuffix: string): boolean {
  const normalizedHost = normalizeLowercaseStringOrEmpty(hostname);
  const normalizedSuffix = normalizeLowercaseStringOrEmpty(trustedSuffix);
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}

function parseFalImageGenerationResponse(payload: unknown): {
  images: Record<string, unknown>[];
  prompt?: string;
} {
  if (!isRecord(payload)) {
    throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
  }
  const rawImages = payload.images;
  if (rawImages === undefined || rawImages === null) {
    return { images: [], prompt: normalizeOptionalString(payload.prompt) };
  }
  if (!Array.isArray(rawImages)) {
    throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
  }
  const images: Record<string, unknown>[] = [];
  for (const entry of rawImages) {
    if (!isRecord(entry)) {
      throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
    }
    images.push(entry);
  }
  return { images, prompt: normalizeOptionalString(payload.prompt) };
}

function resolveFalNetworkPolicy(params: {
  baseUrl: string;
  allowPrivateNetwork: boolean;
}): FalNetworkPolicy {
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(params.baseUrl);
  } catch {
    return {};
  }

  const hostSuffix = normalizeLowercaseStringOrEmpty(parsedBaseUrl.hostname);
  if (!hostSuffix || !params.allowPrivateNetwork) {
    return {};
  }

  const hostPolicy = buildHostnameAllowlistPolicyFromSuffixAllowlist([hostSuffix]);
  const privateNetworkPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(true);
  const trustedHostPolicy = mergeSsrFPolicies(hostPolicy, privateNetworkPolicy);
  return {
    apiPolicy: trustedHostPolicy,
    trustedDownloadHostSuffix: hostSuffix,
    trustedDownloadPolicy: trustedHostPolicy,
  };
}

function ensureFalModelPath(model: string | undefined, hasInputImages: boolean): string {
  const trimmed = model?.trim() || DEFAULT_FAL_IMAGE_MODEL;
  const schema = resolveFalImageModelSchema(trimmed);
  if (hasInputImages && schema.appendEditPath === false) {
    return trimmed;
  }
  if (!hasInputImages) {
    return trimmed;
  }
  if (
    trimmed.endsWith("/edit") ||
    trimmed.endsWith(`/${DEFAULT_FAL_EDIT_SUBPATH}`) ||
    trimmed.includes("/image-to-image/")
  ) {
    return trimmed;
  }
  // GPT Image 2 and Nano Banana 2 use /edit; Flux uses /image-to-image.
  if (trimmed.startsWith("openai/gpt-image-") || trimmed.startsWith("fal-ai/nano-banana-")) {
    return `${trimmed}/edit`;
  }
  return `${trimmed}/${DEFAULT_FAL_EDIT_SUBPATH}`;
}

function resolveFalImageModelSchema(model: string): FalImageModelSchema {
  if (model.startsWith(FAL_KREA_2_MODEL_PREFIX)) {
    return {
      geometry: "native_aspect_ratio",
      aspectRatios: KREA_SUPPORTED_ASPECT_RATIOS,
      referenceImages: "image_style_references",
      maxInputImages: KREA_STYLE_REFERENCE_MAX_INPUT_IMAGES,
      referenceLimitLabel: "fal Krea 2",
      referenceLimitNoun: "style reference",
      appendEditPath: false,
      supportsCount: false,
      supportsOutputFormat: false,
      defaultBody: { creativity: "medium" },
    };
  }
  if (model.startsWith("openai/gpt-image-") || model.startsWith("fal-ai/nano-banana-")) {
    const isNanoBanana = model.startsWith("fal-ai/nano-banana-");
    return {
      geometry: isNanoBanana ? "native_aspect_ratio" : "image_size",
      ...(isNanoBanana ? { aspectRatios: NANO_BANANA_SUPPORTED_ASPECT_RATIOS } : {}),
      referenceImages: "image_urls",
      maxInputImages: isNanoBanana
        ? NANO_BANANA_EDIT_MAX_INPUT_IMAGES
        : GPT_IMAGE_EDIT_MAX_INPUT_IMAGES,
      referenceLimitLabel: isNanoBanana ? "fal Nano Banana 2" : "fal GPT Image edit",
      referenceLimitNoun: "reference image",
      appendEditPath: "edit",
      supportsCount: true,
      supportsOutputFormat: true,
    };
  }
  return {
    geometry: "image_size",
    referenceImages: "image_url",
    maxInputImages: 1,
    referenceLimitLabel: "fal flux image generation currently",
    referenceLimitNoun: "reference image",
    appendEditPath: "image-to-image",
    supportsCount: true,
    supportsOutputFormat: true,
  };
}

function parseSize(raw: string | undefined): { width: number; height: number } | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d{2,5})x(\d{2,5})$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function mapResolutionToEdge(resolution: "1K" | "2K" | "4K" | undefined): number | undefined {
  if (!resolution) {
    return undefined;
  }
  return resolution === "4K" ? 4096 : resolution === "2K" ? 2048 : 1024;
}

function aspectRatioToEnum(aspectRatio: string | undefined): string | undefined {
  const normalized = aspectRatio?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1:1") {
    return "square_hd";
  }
  if (normalized === "4:3") {
    return "landscape_4_3";
  }
  if (normalized === "3:4") {
    return "portrait_4_3";
  }
  if (normalized === "16:9") {
    return "landscape_16_9";
  }
  if (normalized === "9:16") {
    return "portrait_16_9";
  }
  return undefined;
}

function parseAspectRatioParts(aspectRatio: string): { widthRatio: number; heightRatio: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(aspectRatio.trim());
  if (!match) {
    throw new Error(`Invalid fal aspect ratio: ${aspectRatio}`);
  }
  const widthRatio = Number.parseFloat(match[1] ?? "");
  const heightRatio = Number.parseFloat(match[2] ?? "");
  if (
    !Number.isFinite(widthRatio) ||
    !Number.isFinite(heightRatio) ||
    widthRatio <= 0 ||
    heightRatio <= 0
  ) {
    throw new Error(`Invalid fal aspect ratio: ${aspectRatio}`);
  }
  return { widthRatio, heightRatio };
}

function aspectRatioToDimensions(
  aspectRatio: string,
  edge: number,
): { width: number; height: number } {
  const { widthRatio, heightRatio } = parseAspectRatioParts(aspectRatio);
  if (widthRatio >= heightRatio) {
    return {
      width: edge,
      height: Math.max(1, Math.round((edge * heightRatio) / widthRatio)),
    };
  }
  return {
    width: Math.max(1, Math.round((edge * widthRatio) / heightRatio)),
    height: edge,
  };
}

function resolveFalImageSize(params: {
  size?: string;
  resolution?: "1K" | "2K" | "4K";
  aspectRatio?: string;
  hasInputImages: boolean;
}): FalImageSize | undefined {
  const parsed = parseSize(params.size);
  if (parsed) {
    return parsed;
  }

  const normalizedAspectRatio = params.aspectRatio?.trim();
  if (normalizedAspectRatio && params.hasInputImages) {
    return (
      aspectRatioToEnum(normalizedAspectRatio) ??
      aspectRatioToDimensions(normalizedAspectRatio, 1024)
    );
  }

  const edge = mapResolutionToEdge(params.resolution);
  if (normalizedAspectRatio && edge) {
    return aspectRatioToDimensions(normalizedAspectRatio, edge);
  }
  if (edge) {
    return { width: edge, height: edge };
  }
  if (normalizedAspectRatio) {
    return (
      aspectRatioToEnum(normalizedAspectRatio) ??
      aspectRatioToDimensions(normalizedAspectRatio, 1024)
    );
  }
  return undefined;
}

function aspectRatioScore(aspectRatio: string, targetRatio: number): number {
  const { widthRatio, heightRatio } = parseAspectRatioParts(aspectRatio);
  return Math.abs(Math.log(widthRatio / heightRatio) - Math.log(targetRatio));
}

function resolveClosestFalAspectRatioForSize(
  imageSize: FalImageSize | undefined,
  aspectRatios: readonly string[],
): string | undefined {
  if (!imageSize || typeof imageSize === "string") {
    return undefined;
  }
  const targetRatio = imageSize.width / imageSize.height;
  return aspectRatios.reduce<string | undefined>((best, candidate) => {
    if (!best) {
      return candidate;
    }
    return aspectRatioScore(candidate, targetRatio) < aspectRatioScore(best, targetRatio)
      ? candidate
      : best;
  }, undefined);
}

function resolveKreaCreativity(raw: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  return (KREA_CREATIVITY_LEVELS as readonly string[]).includes(normalized) ? normalized : "medium";
}

function resolveFalCreativityOption(providerOptions: Record<string, unknown> | undefined): string {
  const falOptions = isRecord(providerOptions?.fal) ? providerOptions.fal : undefined;
  return typeof falOptions?.creativity === "string" ? falOptions.creativity : "";
}

function resolveNativeFalAspectRatio(params: {
  schema: FalImageModelSchema;
  aspectRatio?: string;
  imageSize?: FalImageSize;
}): string | undefined {
  const requestedAspectRatio = params.aspectRatio?.trim();
  const allowedAspectRatios = params.schema.aspectRatios;
  if (requestedAspectRatio) {
    if (allowedAspectRatios && !allowedAspectRatios.includes(requestedAspectRatio)) {
      throw new Error(
        `${params.schema.referenceLimitLabel} supports aspectRatio values: ${allowedAspectRatios.join(", ")}`,
      );
    }
    return requestedAspectRatio;
  }
  if (allowedAspectRatios) {
    return resolveClosestFalAspectRatioForSize(params.imageSize, allowedAspectRatios);
  }
  return undefined;
}

function applyFalImageGeometry(params: {
  requestBody: Record<string, unknown>;
  schema: FalImageModelSchema;
  imageSize?: FalImageSize;
  size?: string;
  aspectRatio?: string;
  resolution?: "1K" | "2K" | "4K";
  hasInputImages: boolean;
}) {
  if (params.schema.geometry === "native_aspect_ratio") {
    if (params.resolution && params.schema.referenceImages === "image_style_references") {
      throw new Error("fal Krea 2 supports aspectRatio but not resolution overrides");
    }
    const nativeAspectRatio = resolveNativeFalAspectRatio({
      schema: params.schema,
      aspectRatio: params.aspectRatio,
      imageSize: params.size ? params.imageSize : undefined,
    });
    if (nativeAspectRatio) {
      params.requestBody.aspect_ratio = nativeAspectRatio;
    }
    if (params.resolution && params.schema.referenceImages === "image_urls") {
      params.requestBody.resolution = params.resolution;
    }
    return;
  }
  if (params.imageSize !== undefined) {
    params.requestBody.image_size = params.imageSize;
  }
}

function applyFalReferenceImages(params: {
  requestBody: Record<string, unknown>;
  schema: FalImageModelSchema;
  inputImages: ImageGenerationSourceImage[];
}) {
  const encoded = params.inputImages.map((img) => toImageDataUrl(img));
  if (params.schema.referenceImages === "image_urls") {
    params.requestBody.image_urls = encoded;
    return;
  }
  if (params.schema.referenceImages === "image_style_references") {
    params.requestBody.image_style_references = encoded.map((imageUrl) => ({
      image_url: imageUrl,
    }));
    return;
  }
  const [input] = encoded;
  if (!input) {
    throw new Error("fal image edit request missing reference image");
  }
  params.requestBody.image_url = input;
}

function formatFalReferenceLimitError(
  schema: FalImageModelSchema,
  inputImageCount: number,
): string {
  const limit = schema.maxInputImages === 1 ? "one" : String(schema.maxInputImages);
  const noun =
    schema.maxInputImages === 1 ? schema.referenceLimitNoun : `${schema.referenceLimitNoun}s`;
  return `${schema.referenceLimitLabel} supports at most ${limit} ${noun} (requested ${inputImageCount})`;
}

async function fetchImageBuffer(
  url: string,
  networkPolicy?: FalNetworkPolicy,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const downloadPolicy = (() => {
    const trustedSuffix = networkPolicy?.trustedDownloadHostSuffix;
    const trustedPolicy = networkPolicy?.trustedDownloadPolicy;
    if (!trustedSuffix || !trustedPolicy) {
      return undefined;
    }
    try {
      const parsed = new URL(url);
      return matchesTrustedHostSuffix(parsed.hostname, trustedSuffix) ? trustedPolicy : undefined;
    } catch {
      return undefined;
    }
  })();
  const { response, release } = await falFetchGuard({
    url,
    policy: downloadPolicy,
    auditContext: "fal-image-download",
  });
  try {
    await assertOkOrThrowProviderError(response, "fal image download failed");
    const mimeType = response.headers.get("content-type")?.trim() || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType };
  } finally {
    await release();
  }
}

export function buildFalImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "fal",
    label: "fal",
    defaultModel: DEFAULT_FAL_IMAGE_MODEL,
    models: [
      DEFAULT_FAL_IMAGE_MODEL,
      `${DEFAULT_FAL_IMAGE_MODEL}/${DEFAULT_FAL_EDIT_SUBPATH}`,
      FAL_KREA_2_MEDIUM_MODEL,
      FAL_KREA_2_LARGE_MODEL,
    ],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "fal",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: GPT_IMAGE_EDIT_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: [...FAL_SUPPORTED_SIZES],
        sizesByModel: {
          [FAL_KREA_2_MEDIUM_MODEL]: [],
          [FAL_KREA_2_LARGE_MODEL]: [],
        },
        aspectRatios: [...FAL_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
      output: {
        formats: [...FAL_OUTPUT_FORMATS],
      },
    },
    async generateImage(req) {
      const inputImageCount = req.inputImages?.length ?? 0;
      const hasInputImages = inputImageCount > 0;
      const requestedModel = req.model?.trim() || DEFAULT_FAL_IMAGE_MODEL;
      const schema = resolveFalImageModelSchema(requestedModel);
      const imageSize = resolveFalImageSize({
        size: req.size,
        resolution: req.resolution,
        aspectRatio: req.aspectRatio,
        hasInputImages,
      });
      const model = ensureFalModelPath(req.model, hasInputImages);

      if (hasInputImages && inputImageCount > schema.maxInputImages) {
        throw new Error(formatFalReferenceLimitError(schema, inputImageCount));
      }

      // Flux/custom edit endpoints use the singular image_url contract.
      if (hasInputImages && schema.referenceImages === "image_url") {
        if (req.aspectRatio) {
          throw new Error("fal flux image edit endpoint does not support aspectRatio overrides");
        }
      }
      if (!schema.supportsCount && (req.count ?? 1) > 1) {
        throw new Error(`fal ${requestedModel} supports one output image per request`);
      }
      if (!schema.supportsOutputFormat && req.outputFormat) {
        throw new Error(`fal ${requestedModel} does not support outputFormat overrides`);
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveFalHttpRequestConfig({ req, capability: "image" });
      const networkPolicy = resolveFalNetworkPolicy({ baseUrl, allowPrivateNetwork });
      const requestBody: Record<string, unknown> = {
        prompt: req.prompt,
        ...(schema.supportsCount ? { num_images: req.count ?? 1 } : {}),
        ...(schema.supportsOutputFormat
          ? { output_format: req.outputFormat ?? DEFAULT_OUTPUT_FORMAT }
          : {}),
        ...schema.defaultBody,
      };
      if (schema.referenceImages === "image_style_references") {
        requestBody.creativity = resolveKreaCreativity(
          resolveFalCreativityOption(req.providerOptions),
        );
      }
      applyFalImageGeometry({
        requestBody,
        schema,
        imageSize,
        size: req.size,
        aspectRatio: req.aspectRatio,
        resolution: req.resolution,
        hasInputImages,
      });

      if (hasInputImages) {
        applyFalReferenceImages({
          requestBody,
          schema,
          inputImages: req.inputImages ?? [],
        });
      }
      const { response, release } = await falFetchGuard({
        url: `${baseUrl}/${model}`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
        timeoutMs: req.timeoutMs,
        policy: networkPolicy.apiPolicy,
        dispatcherPolicy,
        auditContext: "fal-image-generate",
      });
      try {
        await assertOkOrThrowHttpError(response, "fal image generation failed");

        const payload = parseFalImageGenerationResponse(await response.json());
        const images: GeneratedImageAsset[] = [];
        let imageIndex = 0;
        for (const entry of payload.images) {
          const url = normalizeOptionalString(entry.url);
          if (!url) {
            throw new Error(FAL_IMAGE_MALFORMED_RESPONSE);
          }
          const downloaded = await fetchImageBuffer(url, networkPolicy);
          imageIndex += 1;
          images.push({
            buffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            fileName: `image-${imageIndex}.${imageFileExtensionForMimeType(
              downloaded.mimeType || normalizeOptionalString(entry.content_type),
            )}`,
          });
        }

        if (images.length === 0) {
          throw new Error("fal image generation response missing image data");
        }

        return {
          images,
          model,
          metadata: payload.prompt ? { prompt: payload.prompt } : undefined,
        };
      } finally {
        await release();
      }
    },
  };
}
