import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import {
  imageFileExtensionForMimeType,
  toImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
  mergeSsrFPolicies,
  type SsrFPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux/dev";
const DEFAULT_FAL_EDIT_SUBPATH = "image-to-image";
const DEFAULT_OUTPUT_FORMAT = "png";
const FAL_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const FAL_SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
] as const;
const FAL_SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;

type FalGeneratedImage = {
  url?: string;
  content_type?: string;
};

type FalImageGenerationResponse = {
  images?: FalGeneratedImage[];
  prompt?: string;
};

type FalImageSize = string | { width: number; height: number };
type FalNetworkPolicy = {
  apiPolicy?: SsrFPolicy;
  trustedDownloadHostSuffix?: string;
  trustedDownloadPolicy?: SsrFPolicy;
};

let falFetchGuard = fetchWithSsrFGuard;

export function _setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  falFetchGuard = impl ?? fetchWithSsrFGuard;
}

function matchesTrustedHostSuffix(hostname: string, trustedSuffix: string): boolean {
  const normalizedHost = normalizeLowercaseStringOrEmpty(hostname);
  const normalizedSuffix = normalizeLowercaseStringOrEmpty(trustedSuffix);
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
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
  if (!hasInputImages) {
    return trimmed;
  }
  if (
    trimmed.endsWith(`/${DEFAULT_FAL_EDIT_SUBPATH}`) ||
    trimmed.endsWith("/edit") ||
    trimmed.includes("/image-to-image/")
  ) {
    return trimmed;
  }
  return `${trimmed}/${DEFAULT_FAL_EDIT_SUBPATH}`;
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

function aspectRatioToDimensions(
  aspectRatio: string,
  edge: number,
): { width: number; height: number } {
  const match = /^(\d+):(\d+)$/u.exec(aspectRatio.trim());
  if (!match) {
    throw new Error(`Invalid fal aspect ratio: ${aspectRatio}`);
  }
  const widthRatio = Number.parseInt(match[1] ?? "", 10);
  const heightRatio = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isFinite(widthRatio) ||
    !Number.isFinite(heightRatio) ||
    widthRatio <= 0 ||
    heightRatio <= 0
  ) {
    throw new Error(`Invalid fal aspect ratio: ${aspectRatio}`);
  }
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
    throw new Error("fal image edit endpoint does not support aspectRatio overrides");
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
    models: [DEFAULT_FAL_IMAGE_MODEL, `${DEFAULT_FAL_IMAGE_MODEL}/${DEFAULT_FAL_EDIT_SUBPATH}`],
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
        maxInputImages: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: true,
      },
      geometry: {
        sizes: [...FAL_SUPPORTED_SIZES],
        aspectRatios: [...FAL_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
      output: {
        formats: [...FAL_OUTPUT_FORMATS],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "fal",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("fal API key missing");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("fal image generation currently supports at most one reference image");
      }

      const hasInputImages = (req.inputImages?.length ?? 0) > 0;
      const imageSize = resolveFalImageSize({
        size: req.size,
        resolution: req.resolution,
        aspectRatio: req.aspectRatio,
        hasInputImages,
      });
      const model = ensureFalModelPath(req.model, hasInputImages);
      const explicitBaseUrl = req.cfg?.models?.providers?.fal?.baseUrl?.trim();
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: explicitBaseUrl,
          defaultBaseUrl: DEFAULT_FAL_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Key ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "fal",
          capability: "image",
          transport: "http",
        });
      const networkPolicy = resolveFalNetworkPolicy({ baseUrl, allowPrivateNetwork });
      const requestBody: Record<string, unknown> = {
        prompt: req.prompt,
        num_images: req.count ?? 1,
        output_format: req.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
      };
      if (imageSize !== undefined) {
        requestBody.image_size = imageSize;
      }

      if (hasInputImages) {
        const [input] = req.inputImages ?? [];
        if (!input) {
          throw new Error("fal image edit request missing reference image");
        }
        requestBody.image_url = toImageDataUrl(input);
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

        const payload = (await response.json()) as FalImageGenerationResponse;
        const images: GeneratedImageAsset[] = [];
        let imageIndex = 0;
        for (const entry of payload.images ?? []) {
          const url = entry.url?.trim();
          if (!url) {
            continue;
          }
          const downloaded = await fetchImageBuffer(url, networkPolicy);
          imageIndex += 1;
          images.push({
            buffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            fileName: `image-${imageIndex}.${imageFileExtensionForMimeType(
              downloaded.mimeType || entry.content_type,
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
