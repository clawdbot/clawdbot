import { resolve, isAbsolute } from "node:path";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../../config/types.tools.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import { matchesMediaEntryCapability } from "../../media-understanding/entry-capabilities.js";
import { normalizeMediaProviderId } from "../../media-understanding/provider-id.js";
import { getMediaUnderstandingProvider } from "../../media-understanding/provider-registry.js";
import { resolveTimeoutMs } from "../../media-understanding/resolve.js";
import { buildProviderRegistry } from "../../media-understanding/runner.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { loadWebMedia } from "../../media/web-media.js";
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import { resolveUserPath } from "../../utils.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import {
  coerceImageAssistantText,
  coerceImageModelConfig,
  decodeDataUrl,
  hasImageReasoningOnlyResponse,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import {
  applyImageModelConfigDefaults,
  buildTextToolResult,
  resolveMediaToolLocalRoots,
  resolveRemoteMediaSsrfPolicy,
  resolvePromptAndModelOverride,
} from "./media-tool-shared.js";
import {
  buildToolModelConfigFromCandidates,
  hasToolModelConfig,
  resolveDefaultModelRef,
} from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  runWithImageModelFallback,
  type AnyAgentTool,
  type SandboxedBridgeMediaPathConfig,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Describe the image.";
const DEFAULT_MAX_IMAGES = 20;

const imageToolProviderDeps = {
  buildProviderRegistry,
  getMediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
};

export const __testing = {
  decodeDataUrl,
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
  resolveImageToolMaxTokens,
  setProviderDepsForTest(overrides?: {
    buildProviderRegistry?: typeof buildProviderRegistry;
    getMediaUnderstandingProvider?: typeof getMediaUnderstandingProvider;
    describeImageWithModel?: typeof describeImageWithModel;
    describeImagesWithModel?: typeof describeImagesWithModel;
    resolveAutoMediaKeyProviders?: typeof resolveAutoMediaKeyProviders;
    resolveDefaultMediaModel?: typeof resolveDefaultMediaModel;
  }) {
    imageToolProviderDeps.buildProviderRegistry =
      overrides?.buildProviderRegistry ?? buildProviderRegistry;
    imageToolProviderDeps.getMediaUnderstandingProvider =
      overrides?.getMediaUnderstandingProvider ?? getMediaUnderstandingProvider;
    imageToolProviderDeps.describeImageWithModel =
      overrides?.describeImageWithModel ?? describeImageWithModel;
    imageToolProviderDeps.describeImagesWithModel =
      overrides?.describeImagesWithModel ?? describeImagesWithModel;
    imageToolProviderDeps.resolveAutoMediaKeyProviders =
      overrides?.resolveAutoMediaKeyProviders ?? resolveAutoMediaKeyProviders;
    imageToolProviderDeps.resolveDefaultMediaModel =
      overrides?.resolveDefaultMediaModel ?? resolveDefaultMediaModel;
  },
} as const;

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

/**
 * Resolve the effective image model config for the `image` tool.
 *
 * - Prefer explicit config (`agents.defaults.imageModel`).
 * - Otherwise, try to "pair" the primary model with an image-capable model:
 *   - same provider (best effort)
 *   - fall back to OpenAI/Anthropic when available
 */
export function resolveImageModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
}): ImageModelConfig | null {
  // Note: We intentionally do NOT gate based on primarySupportsImages here.
  // Even when the primary model supports images, we keep the tool available
  // because images are auto-injected into prompts (see attempt.ts detectAndLoadPromptImages).
  // The tool description is adjusted via modelHasVision to discourage redundant usage.
  const explicit = coerceImageModelConfig(params.cfg);
  if (hasToolModelConfig(explicit)) {
    return resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicit,
    });
  }

  const primary = resolveDefaultModelRef(params.cfg);

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const primaryCandidates = (() => {
    if (providerVisionFromConfig) {
      return [providerVisionFromConfig];
    }
    const providerDefault = imageToolProviderDeps.resolveDefaultMediaModel({
      cfg: params.cfg,
      providerId: primary.provider,
      capability: "image",
    });
    if (providerDefault) {
      return [`${primary.provider}/${providerDefault}`];
    }
    if (isMinimaxVlmProvider(primary.provider)) {
      return [`${primary.provider}/MiniMax-VL-01`];
    }
    return [];
  })();

  const autoCandidates = imageToolProviderDeps
    .resolveAutoMediaKeyProviders({
      cfg: params.cfg,
      capability: "image",
    })
    .map((providerId) => {
      const modelId = imageToolProviderDeps.resolveDefaultMediaModel({
        cfg: params.cfg,
        providerId,
        capability: "image",
      });
      return modelId ? `${providerId}/${modelId}` : null;
    });

  return buildToolModelConfigFromCandidates({
    explicit,
    agentDir: params.agentDir,
    candidates: [...primaryCandidates, ...autoCandidates],
  });
}

function pickMaxBytes(cfg?: OpenClawConfig, maxBytesMb?: number): number | undefined {
  if (typeof maxBytesMb === "number" && Number.isFinite(maxBytesMb) && maxBytesMb > 0) {
    return Math.floor(maxBytesMb * 1024 * 1024);
  }
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

function matchesImageTimeoutEntry(params: {
  entry: MediaUnderstandingModelConfig;
  source: "capability" | "shared";
  provider: string;
  model: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): boolean {
  const configuredProvider = normalizeMediaProviderId(params.entry.provider ?? "");
  const selectedProvider = normalizeMediaProviderId(params.provider);
  if (!configuredProvider || configuredProvider !== selectedProvider) {
    return false;
  }
  if (
    !matchesMediaEntryCapability({
      entry: params.entry,
      source: params.source,
      capability: "image",
      providerRegistry: params.providerRegistry,
    })
  ) {
    return false;
  }
  const configuredModel = params.entry.model?.trim();
  if (!configuredModel) {
    return true;
  }
  const providerPrefix = `${selectedProvider}/`;
  const normalizedConfiguredModel = configuredModel.startsWith(providerPrefix)
    ? configuredModel.slice(providerPrefix.length)
    : configuredModel;
  return normalizedConfiguredModel === params.model;
}

function resolveImageToolTimeoutMs(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  providerRegistry: Map<string, MediaUnderstandingProvider>;
}): number {
  const imageConfig = params.cfg.tools?.media?.image;
  const capabilityEntry = imageConfig?.models?.find((entry) =>
    matchesImageTimeoutEntry({
      entry,
      source: "capability",
      provider: params.provider,
      model: params.model,
      providerRegistry: params.providerRegistry,
    }),
  );
  const sharedEntry = params.cfg.tools?.media?.models?.find((entry) =>
    matchesImageTimeoutEntry({
      entry,
      source: "shared",
      provider: params.provider,
      model: params.model,
      providerRegistry: params.providerRegistry,
    }),
  );
  return resolveTimeoutMs(
    capabilityEntry?.timeoutSeconds ?? sharedEntry?.timeoutSeconds ?? imageConfig?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS.image,
  );
}

type ImageSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function runImagePrompt(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  imageModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  images: Array<{ buffer: Buffer; mimeType: string }>;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.imageModelConfig);
  const providerCfg: OpenClawConfig = effectiveCfg ?? {};
  const providerRegistry = imageToolProviderDeps.buildProviderRegistry(undefined, providerCfg);

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const timeoutMs = resolveImageToolTimeoutMs({
        cfg: providerCfg,
        provider,
        model: modelId,
        providerRegistry: providerRegistry as Map<string, MediaUnderstandingProvider>,
      });
      const imageProvider = imageToolProviderDeps.getMediaUnderstandingProvider(
        provider,
        providerRegistry as Map<string, MediaUnderstandingProvider>,
      );
      if (
        params.images.length > 1 &&
        (imageProvider?.describeImages || !imageProvider?.describeImage)
      ) {
        const describeImages =
          imageProvider?.describeImages ?? imageToolProviderDeps.describeImagesWithModel;
        const described = await describeImages({
          images: params.images.map((image, index) => ({
            buffer: image.buffer,
            fileName: `image-${index + 1}`,
            mime: image.mimeType,
          })),
          provider,
          model: modelId,
          prompt: params.prompt,
          maxTokens: resolveImageToolMaxTokens(undefined),
          timeoutMs,
          cfg: providerCfg,
          agentDir: params.agentDir,
        });
        return { text: described.text, provider, model: described.model ?? modelId };
      }
      const describeImage =
        imageProvider?.describeImage ?? imageToolProviderDeps.describeImageWithModel;
      if (params.images.length === 1) {
        const image = params.images[0];
        const described = await describeImage({
          buffer: image.buffer,
          fileName: "image-1",
          mime: image.mimeType,
          provider,
          model: modelId,
          prompt: params.prompt,
          maxTokens: resolveImageToolMaxTokens(undefined),
          timeoutMs,
          cfg: providerCfg,
          agentDir: params.agentDir,
        });
        return { text: described.text, provider, model: described.model ?? modelId };
      }

      const parts: string[] = [];
      for (const [index, image] of params.images.entries()) {
        const described = await describeImage({
          buffer: image.buffer,
          fileName: `image-${index + 1}`,
          mime: image.mimeType,
          provider,
          model: modelId,
          prompt: `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length}.`,
          maxTokens: resolveImageToolMaxTokens(undefined),
          timeoutMs,
          cfg: providerCfg,
          agentDir: params.agentDir,
        });
        parts.push(`Image ${index + 1}:\n${described.text.trim()}`);
      }
      return {
        text: parts.join("\n\n").trim(),
        provider,
        model: modelId,
      };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    attempts: result.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      error: attempt.error,
    })),
  };
}

export function createImageTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: ImageSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  /** If true, the model has native vision capability and images in the prompt are auto-injected */
  modelHasVision?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    const explicit = coerceImageModelConfig(options?.config);
    if (hasToolModelConfig(explicit)) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const imageModelConfig = resolveImageModelConfigForTool({
    cfg: options?.config,
    agentDir,
  });
  if (!imageModelConfig) {
    return null;
  }
  const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(options?.config);

  // If model has native vision, images in the prompt are auto-injected
  // so this tool is only needed when image wasn't provided in the prompt
  const description = options?.modelHasVision
    ? "Analyze one or more images with a vision model. Use image for a single path/URL, or images for multiple (up to 20). Only use this tool when images were NOT already provided in the user's message. Images mentioned in the prompt are automatically visible to you."
    : "Analyze one or more images with the configured image model (agents.defaults.imageModel). Use image for a single path/URL, or images for multiple (up to 20). Provide a prompt describing what to analyze.";

  return {
    label: "Image",
    name: "image",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      image: Type.Optional(Type.String({ description: "Single image path or URL." })),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple image paths or URLs (up to maxImages, default 20).",
        }),
      ),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
      maxImages: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // MARK: - Normalize image + images input and dedupe while preserving order
      const imageCandidates: string[] = [];
      if (typeof record.image === "string") {
        imageCandidates.push(record.image);
      }
      if (Array.isArray(record.images)) {
        imageCandidates.push(...record.images.filter((v): v is string => typeof v === "string"));
      }

      const seenImages = new Set<string>();
      const imageInputs: string[] = [];
      for (const candidate of imageCandidates) {
        const trimmedCandidate = candidate.trim();
        const normalizedForDedupe = trimmedCandidate.startsWith("@")
          ? trimmedCandidate.slice(1).trim()
          : trimmedCandidate;
        if (!normalizedForDedupe || seenImages.has(normalizedForDedupe)) {
          continue;
        }
        seenImages.add(normalizedForDedupe);
        imageInputs.push(trimmedCandidate);
      }
      if (imageInputs.length === 0) {
        throw new Error("image required");
      }

      // MARK: - Enforce max images cap
      const maxImagesRaw = typeof record.maxImages === "number" ? record.maxImages : undefined;
      const maxImages =
        typeof maxImagesRaw === "number" && Number.isFinite(maxImagesRaw) && maxImagesRaw > 0
          ? Math.floor(maxImagesRaw)
          : DEFAULT_MAX_IMAGES;
      if (imageInputs.length > maxImages) {
        return {
          content: [
            {
              type: "text",
              text: `Too many images: ${imageInputs.length} provided, maximum is ${maxImages}. Please reduce the number of images.`,
            },
          ],
          details: { error: "too_many_images", count: imageInputs.length, max: maxImages },
        };
      }

      const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(
        record,
        DEFAULT_PROMPT,
      );
      const maxBytesMb = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytes = pickMaxBytes(options?.config, maxBytesMb);

      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options?.sandbox.root.trim()
          ? {
              root: options.sandbox.root.trim(),
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Load and resolve each image
      const loadedImages: Array<{
        buffer: Buffer;
        mimeType: string;
        resolvedImage: string;
        rewrittenFrom?: string;
      }> = [];

      for (const imageRawInput of imageInputs) {
        const trimmed = imageRawInput.trim();
        const imageRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
        if (!imageRaw) {
          throw new Error("image required (empty string in array)");
        }

        const normalizedRef = normalizeMediaReferenceSource(imageRaw);

        // The tool accepts file paths, file/data URLs, or http(s) URLs. In some
        // agent/model contexts, images can be referenced as pseudo-URIs like
        // `image:0` (e.g. "first image in the prompt"). We don't have access to a
        // shared image registry here, so fail gracefully instead of attempting to
        // `fs.readFile("image:0")` and producing a noisy ENOENT.
        const refInfo = classifyMediaReferenceSource(normalizedRef);
        const { isDataUrl, isFileUrl, isHttpUrl } = refInfo;
        if (refInfo.hasUnsupportedScheme) {
          return {
            content: [
              {
                type: "text",
                text: `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
              },
            ],
            details: {
              error: "unsupported_image_reference",
              image: imageRawInput,
            },
          };
        }

        if (sandboxConfig && isHttpUrl) {
          throw new Error("Sandboxed image tool does not allow remote URLs.");
        }

        const resolvedImage = (() => {
          if (sandboxConfig) {
            return normalizedRef;
          }
          if (normalizedRef.startsWith("~")) {
            return resolveUserPath(normalizedRef);
          }
          // Resolve relative paths against workspaceDir so agents can reference
          // workspace-relative paths (e.g. "inbox/photo.png") without needing to
          // know the absolute workspace location — matching the read tool behaviour.
          if (
            !isDataUrl &&
            !isFileUrl &&
            !isHttpUrl &&
            !refInfo.looksLikeWindowsDrivePath &&
            !isAbsolute(normalizedRef) &&
            options?.workspaceDir
          ) {
            return resolve(options.workspaceDir, normalizedRef);
          }
          return normalizedRef;
        })();
        const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
          ? { resolved: "" }
          : sandboxConfig
            ? await resolveSandboxedBridgeMediaPath({
                sandbox: sandboxConfig,
                mediaPath: resolvedImage,
                inboundFallbackDir: "media/inbound",
              })
            : {
                resolved: resolvedImage.startsWith("file://")
                  ? resolvedImage.slice("file://".length)
                  : resolvedImage,
              };
        const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
        const mediaLocalRoots = resolveMediaToolLocalRoots(
          options?.workspaceDir,
          {
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
          },
          resolvedPath ? [resolvedPath] : undefined,
        );

        const media = isDataUrl
          ? decodeDataUrl(resolvedImage, { maxBytes })
          : sandboxConfig
            ? await loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                sandboxValidated: true,
                readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
              })
            : await loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                localRoots: mediaLocalRoots,
                ssrfPolicy: remoteMediaSsrfPolicy,
              });
        if (media.kind !== "image") {
          throw new Error(`Unsupported media type: ${media.kind}`);
        }

        const mimeType =
          ("contentType" in media && media.contentType) ||
          ("mimeType" in media && media.mimeType) ||
          "image/png";
        loadedImages.push({
          buffer: media.buffer,
          mimeType,
          resolvedImage,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      // MARK: - Run image prompt with all loaded images
      const result = await runImagePrompt({
        cfg: options?.config,
        agentDir,
        imageModelConfig,
        modelOverride,
        prompt: promptRaw,
        images: loadedImages.map((img) => ({ buffer: img.buffer, mimeType: img.mimeType })),
      });

      const imageDetails =
        loadedImages.length === 1
          ? {
              image: loadedImages[0].resolvedImage,
              ...(loadedImages[0].rewrittenFrom
                ? { rewrittenFrom: loadedImages[0].rewrittenFrom }
                : {}),
            }
          : {
              images: loadedImages.map((img) =>
                Object.assign(
                  { image: img.resolvedImage },
                  img.rewrittenFrom ? { rewrittenFrom: img.rewrittenFrom } : {},
                ),
              ),
            };

      return buildTextToolResult(result, imageDetails);
    },
  };
}
