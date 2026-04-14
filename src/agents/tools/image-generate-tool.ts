import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseImageGenerationModelRef } from "../../image-generation/model-ref.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import { resolveConfiguredMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { getImageMetadata } from "../../media/image-ops.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import { resolveUserPath } from "../../utils.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  applyImageGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  isCapabilityProviderConfigured,
  normalizeMediaReferenceInputs,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const MAX_INPUT_IMAGES = 5;
const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const SUPPORTED_ASPECT_RATIOS = new Set([
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
]);

const ImageGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default) or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Image generation prompt." })),
  image: Type.Optional(
    Type.String({
      description: "Optional reference image path or URL for edit mode.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images for edit mode (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional provider/model override, e.g. openai/gpt-image-1." }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename hint. OpenClaw preserves the basename and saves under its managed media directory.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description:
        "Optional size hint like 1024x1024, 1536x1024, 1024x1536, 1024x1792, or 1792x1024.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        "Optional aspect ratio hint: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description:
        "Optional resolution hint: 1K, 2K, or 4K. Useful for Google edit/generation flows.",
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description: `Optional number of images to request (1-${MAX_COUNT}).`,
      minimum: 1,
      maximum: MAX_COUNT,
    }),
  ),
});

function getImageGenerationProviderAuthEnvVars(providerId: string): string[] {
  return getProviderEnvVars(providerId);
}

export function resolveImageGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    modelConfig: params.cfg?.agents?.defaults?.imageGenerationModel,
    providers: listRuntimeImageGenerationProviders({ config: params.cfg }),
  });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" {
  return resolveGenerateAction({
    args,
    allowed: ["generate", "list"],
    defaultAction: "generate",
  });
}

function resolveRequestedCount(args: Record<string, unknown>): number {
  const count = readNumberParam(args, "count", { integer: true });
  if (count === undefined) {
    return DEFAULT_COUNT;
  }
  if (count < 1 || count > MAX_COUNT) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  return count;
}

function normalizeResolution(raw: string | undefined): ImageGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
  );
}

function normalizeReferenceImages(args: Record<string, unknown>): string[] {
  return normalizeMediaReferenceInputs({
    args,
    singularKey: "image",
    pluralKey: "images",
    maxCount: MAX_INPUT_IMAGES,
    label: "reference images",
  });
}

function resolveSelectedImageGenerationProvider(params: {
  config?: OpenClawConfig;
  imageGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): ImageGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: listRuntimeImageGenerationProviders({ config: params.config }),
    modelConfig: params.imageGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
  });
}

function formatIgnoredImageGenerationOverride(override: ImageGenerationIgnoredOverride): string {
  return `${override.key}=${override.value}`;
}

function validateImageGenerationCapabilities(params: {
  provider: ImageGenerationProvider | undefined;
  count: number;
  inputImageCount: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  explicitResolution?: boolean;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const isEdit = params.inputImageCount > 0;
  const modeCaps = isEdit ? provider.capabilities.edit : provider.capabilities.generate;
  const maxCount = modeCaps.maxCount ?? MAX_COUNT;
  if (params.count > maxCount) {
    throw new ToolInputError(
      `${provider.id} ${isEdit ? "edit" : "generate"} supports at most ${maxCount} output image${maxCount === 1 ? "" : "s"}.`,
    );
  }

  if (isEdit) {
    if (!provider.capabilities.edit.enabled) {
      throw new ToolInputError(`${provider.id} does not support reference-image edits.`);
    }
    const maxInputImages = provider.capabilities.edit.maxInputImages ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} edit supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
}

type ImageGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function loadReferenceImages(params: {
  imageInputs: string[];
  maxBytes?: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
}): Promise<
  Array<{
    sourceImage: ImageGenerationSourceImage;
    resolvedImage: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceImage: ImageGenerationSourceImage;
    resolvedImage: string;
    rewrittenFrom?: string;
  }> = [];

  for (const imageRawInput of params.imageInputs) {
    const trimmed = imageRawInput.trim();
    const imageRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!imageRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(imageRaw);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(imageRaw);
    const isFileUrl = /^file:/i.test(imageRaw);
    const isHttpUrl = /^https?:\/\//i.test(imageRaw);
    const isDataUrl = /^data:/i.test(imageRaw);
    if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
      throw new ToolInputError(
        `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError("Sandboxed image_generate does not allow remote URLs.");
    }

    const resolvedImage = (() => {
      if (params.sandboxConfig) {
        return imageRaw;
      }
      if (imageRaw.startsWith("~")) {
        return resolveUserPath(imageRaw);
      }
      return imageRaw;
    })();

    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedImage,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedImage.startsWith("file://")
              ? resolvedImage.slice("file://".length)
              : resolvedImage,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;

    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );

    const media = isDataUrl
      ? decodeDataUrl(resolvedImage, { maxBytes: params.maxBytes })
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedImage, {
            maxBytes: params.maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await loadWebMedia(resolvedPath ?? resolvedImage, {
            maxBytes: params.maxBytes,
            localRoots,
          });
    if (media.kind !== "image") {
      throw new ToolInputError(`Unsupported media type: ${media.kind}`);
    }

    const mimeType =
      ("contentType" in media && media.contentType) ||
      ("mimeType" in media && media.mimeType) ||
      "image/png";

    loaded.push({
      sourceImage: {
        buffer: media.buffer,
        mimeType,
      },
      resolvedImage,
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

async function inferResolutionFromInputImages(
  images: ImageGenerationSourceImage[],
): Promise<ImageGenerationResolution> {
  let maxDimension = 0;
  for (const image of images) {
    const meta = await getImageMetadata(image.buffer);
    const dimension = Math.max(meta?.width ?? 0, meta?.height ?? 0);
    maxDimension = Math.max(maxDimension, dimension);
  }
  if (maxDimension >= 3000) {
    return "4K";
  }
  if (maxDimension >= 1500) {
    return "2K";
  }
  return DEFAULT_RESOLUTION;
}

export function createImageGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: ImageGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null {
  const cfg = options?.config ?? loadConfig();
  const imageGenerationModelConfig = resolveImageGenerationModelConfigForTool({
    cfg,
    agentDir: options?.agentDir,
  });
  if (!imageGenerationModelConfig) {
    return null;
  }
  const effectiveCfg =
    applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) ?? cfg;
  const sandboxConfig =
    options?.sandbox && options.sandbox.root.trim()
      ? {
          root: options.sandbox.root.trim(),
          bridge: options.sandbox.bridge,
          workspaceOnly: options.fsPolicy?.workspaceOnly === true,
        }
      : null;

  return {
    label: "Image Generation",
    name: "image_generate",
    description:
      'Generate new images or edit reference images with the configured or inferred image-generation model. Set agents.defaults.imageGenerationModel.primary to pick a provider/model. Providers declare their own auth/readiness; use action="list" to inspect registered providers, models, readiness, and auth hints. Generated images are delivered automatically from the tool result as MEDIA paths.',
    parameters: ImageGenerateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = resolveAction(params);
      if (action === "list") {
        const runtimeProviders = listRuntimeImageGenerationProviders({ config: effectiveCfg });
        const providers = runtimeProviders.map((provider) => ({
          id: provider.id,
          ...(provider.label ? { label: provider.label } : {}),
          ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
          models: provider.models ?? (provider.defaultModel ? [provider.defaultModel] : []),
          configured: isCapabilityProviderConfigured({
            providers: runtimeProviders,
            provider,
            cfg: effectiveCfg,
            agentDir: options?.agentDir,
          }),
          authEnvVars: getImageGenerationProviderAuthEnvVars(provider.id),
          capabilities: provider.capabilities,
        }));
        const lines = providers.flatMap((provider) => {
          const caps: string[] = [];
          if (provider.capabilities.edit.enabled) {
            const maxRefs = provider.capabilities.edit.maxInputImages;
            caps.push(
              `editing${typeof maxRefs === "number" ? ` up to ${maxRefs} ref${maxRefs === 1 ? "" : "s"}` : ""}`,
            );
          }
          if ((provider.capabilities.geometry?.resolutions?.length ?? 0) > 0) {
            caps.push(`resolutions ${provider.capabilities.geometry?.resolutions?.join("/")}`);
          }
          if ((provider.capabilities.geometry?.sizes?.length ?? 0) > 0) {
            caps.push(`sizes ${provider.capabilities.geometry?.sizes?.join(", ")}`);
          }
          if ((provider.capabilities.geometry?.aspectRatios?.length ?? 0) > 0) {
            caps.push(`aspect ratios ${provider.capabilities.geometry?.aspectRatios?.join(", ")}`);
          }
          const modelLine =
            provider.models.length > 0
              ? `models: ${provider.models.join(", ")}`
              : "models: unknown";
          return [
            `${provider.id}${provider.defaultModel ? ` (default ${provider.defaultModel})` : ""}`,
            `  ${modelLine}`,
            `  configured: ${provider.configured ? "yes" : "no"}`,
            ...(provider.authEnvVars.length > 0
              ? [`  auth: set ${provider.authEnvVars.join(" / ")} to use ${provider.id}/*`]
              : []),
            ...(caps.length > 0 ? [`  capabilities: ${caps.join("; ")}`] : []),
          ];
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { providers },
        };
      }

      const prompt = readStringParam(params, "prompt", { required: true });
      const imageInputs = normalizeReferenceImages(params);
      const model = readStringParam(params, "model");
      const filename = readStringParam(params, "filename");
      const size = readStringParam(params, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(params, "aspectRatio"));
      const explicitResolution = normalizeResolution(readStringParam(params, "resolution"));
      const selectedProvider = resolveSelectedImageGenerationProvider({
        config: effectiveCfg,
        imageGenerationModelConfig,
        modelOverride: model,
      });
      const count = resolveRequestedCount(params);
      const configuredMediaMaxBytes = resolveConfiguredMediaMaxBytes(effectiveCfg);
      const loadedReferenceImages = await loadReferenceImages({
        imageInputs,
        maxBytes: configuredMediaMaxBytes,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
      });
      const inputImages = loadedReferenceImages.map((entry) => entry.sourceImage);
      const modeCaps =
        inputImages.length > 0
          ? selectedProvider?.capabilities.edit
          : selectedProvider?.capabilities.generate;
      const resolution =
        explicitResolution ??
        (size || modeCaps?.supportsResolution === false
          ? undefined
          : inputImages.length > 0
            ? await inferResolutionFromInputImages(inputImages)
            : undefined);
      validateImageGenerationCapabilities({
        provider: selectedProvider,
        count,
        inputImageCount: inputImages.length,
        size,
        aspectRatio,
        resolution,
        explicitResolution: Boolean(explicitResolution),
      });

      const result = await generateImage({
        cfg: effectiveCfg,
        prompt,
        agentDir: options?.agentDir,
        modelOverride: model,
        size,
        aspectRatio,
        resolution,
        count,
        inputImages,
      });
      const ignoredOverrides = result.ignoredOverrides ?? [];
      const warning =
        ignoredOverrides.length > 0
          ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredImageGenerationOverride).join(", ")}.`
          : undefined;
      const normalizedSize =
        result.normalization?.size?.applied ??
        (typeof result.metadata?.normalizedSize === "string" &&
        result.metadata.normalizedSize.trim()
          ? result.metadata.normalizedSize
          : undefined);
      const normalizedAspectRatio =
        result.normalization?.aspectRatio?.applied ??
        (typeof result.metadata?.normalizedAspectRatio === "string" &&
        result.metadata.normalizedAspectRatio.trim()
          ? result.metadata.normalizedAspectRatio
          : undefined);
      const normalizedResolution =
        result.normalization?.resolution?.applied ??
        (typeof result.metadata?.normalizedResolution === "string" &&
        result.metadata.normalizedResolution.trim()
          ? result.metadata.normalizedResolution
          : undefined);
      const sizeTranslatedToAspectRatio =
        result.normalization?.aspectRatio?.derivedFrom === "size" ||
        (!normalizedSize &&
          typeof result.metadata?.requestedSize === "string" &&
          result.metadata.requestedSize === size &&
          Boolean(normalizedAspectRatio));

      const savedImages = await Promise.all(
        result.images.map((image) =>
          saveMediaBuffer(
            image.buffer,
            image.mimeType,
            "tool-image-generation",
            configuredMediaMaxBytes,
            filename || image.fileName,
          ),
        ),
      );

      const revisedPrompts = result.images
        .map((image) => image.revisedPrompt?.trim())
        .filter((entry): entry is string => Boolean(entry));
      const lines = [
        `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
        ...(warning ? [`Warning: ${warning}`] : []),
        // Show the actual saved paths so the model does not invent a bogus
        // local path when it references the generated image in a follow-up reply.
        ...savedImages.map((image) => `MEDIA:${image.path}`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          provider: result.provider,
          model: result.model,
          count: savedImages.length,
          media: {
            mediaUrls: savedImages.map((image) => image.path),
          },
          paths: savedImages.map((image) => image.path),
          ...buildMediaReferenceDetails({
            entries: loadedReferenceImages,
            singleKey: "image",
            pluralKey: "images",
            getResolvedInput: (entry) => entry.resolvedImage,
          }),
          ...(normalizedResolution || resolution
            ? { resolution: normalizedResolution ?? resolution }
            : {}),
          ...(normalizedSize || (size && !sizeTranslatedToAspectRatio)
            ? { size: normalizedSize ?? size }
            : {}),
          ...(normalizedAspectRatio || aspectRatio
            ? { aspectRatio: normalizedAspectRatio ?? aspectRatio }
            : {}),
          ...(filename ? { filename } : {}),
          attempts: result.attempts,
          ...(result.normalization ? { normalization: result.normalization } : {}),
          metadata: result.metadata,
          ...(warning ? { warning } : {}),
          ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
          ...(revisedPrompts.length > 0 ? { revisedPrompts } : {}),
        },
      };
    },
  };
}
