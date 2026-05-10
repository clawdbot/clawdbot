import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseImageGenerationModelRef } from "../../image-generation/model-ref.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationBackground,
  ImageGenerationOpenAIBackground,
  ImageGenerationOpenAIModeration,
  ImageGenerationOpenAIOptions,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationProviderOptions,
  ImageGenerationQuality,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import {
  resolveConfiguredMediaMaxBytes,
  resolveGeneratedMediaMaxBytes,
} from "../../media/configured-max-bytes.js";
import { getImageMetadata } from "../../media/image-ops.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveUserPath } from "../../utils.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { optionalStringEnum } from "../schema/string-enum.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  createMediaGenerateProviderListActionResult,
  type MediaGenerateActionResult,
} from "./media-generate-tool-actions-shared.js";
import {
  applyImageGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  hasGenerationToolAvailability,
  normalizeMediaReferenceInputs,
  readGenerationTimeoutMs,
  resolveRemoteMediaSsrfPolicy,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import {
  coerceToolModelConfig,
  hasToolModelConfig,
  type ToolModelConfig,
} from "./model-config.helpers.js";
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
const SUPPORTED_QUALITIES = ["low", "medium", "high", "auto"] as const;
const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const SUPPORTED_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const SUPPORTED_OPENAI_MODERATIONS = ["low", "auto"] as const;
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
    Type.String({
      description:
        "Optional provider/model override, e.g. openai/gpt-image-2; use openai/gpt-image-1.5 for transparent OpenAI backgrounds.",
    }),
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
        "Optional size hint like 1024x1024, 1536x1024, 1024x1536, 2048x2048, or 3840x2160.",
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
  quality: optionalStringEnum(SUPPORTED_QUALITIES, {
    description: "Optional quality hint: low, medium, high, or auto when the provider supports it.",
  }),
  outputFormat: optionalStringEnum(SUPPORTED_OUTPUT_FORMATS, {
    description: "Optional output format hint: png, jpeg, or webp when the provider supports it.",
  }),
  background: optionalStringEnum(SUPPORTED_BACKGROUNDS, {
    description:
      "Optional background hint: transparent, opaque, or auto when the provider supports it. For transparent output use outputFormat png or webp.",
  }),
  openai: Type.Optional(
    Type.Object({
      background: optionalStringEnum(SUPPORTED_BACKGROUNDS, {
        description:
          "OpenAI-only background hint: transparent, opaque, or auto. For transparent output use outputFormat png or webp; OpenClaw routes the default OpenAI image model to gpt-image-1.5 for this mode.",
      }),
      moderation: optionalStringEnum(SUPPORTED_OPENAI_MODERATIONS, {
        description: "OpenAI-only moderation hint: low or auto.",
      }),
      outputCompression: Type.Optional(
        Type.Number({
          description: "OpenAI-only compression level for jpeg/webp outputFormat, 0-100.",
          minimum: 0,
          maximum: 100,
        }),
      ),
      user: Type.Optional(
        Type.String({
          description: "OpenAI-only stable end-user identifier for abuse monitoring.",
        }),
      ),
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description: `Optional number of images to request (1-${MAX_COUNT}).`,
      minimum: 1,
      maximum: MAX_COUNT,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Optional provider request timeout in milliseconds.",
      minimum: 1,
    }),
  ),
});

function formatImageGenerationAuthHint(provider: {
  id: string;
  authEnvVars: readonly string[];
}): string | undefined {
  if (provider.id === "openai") {
    return "set OPENAI_API_KEY or configure OpenAI Codex OAuth for openai/gpt-image-2";
  }
  if (provider.authEnvVars.length === 0) {
    return undefined;
  }
  return `set ${provider.authEnvVars.join(" / ")} to use ${provider.id}/*`;
}

function listSupportedImageGenerationModes(provider: ImageGenerationProvider): string[] {
  return ["generate", ...(provider.capabilities.edit.enabled ? ["edit"] : [])];
}

function summarizeImageGenerationCapabilities(provider: ImageGenerationProvider): string {
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
  if ((provider.capabilities.output?.formats?.length ?? 0) > 0) {
    caps.push(`formats ${provider.capabilities.output?.formats?.join("/")}`);
  }
  if ((provider.capabilities.output?.backgrounds?.length ?? 0) > 0) {
    caps.push(`backgrounds ${provider.capabilities.output?.backgrounds?.join("/")}`);
  }
  return caps.join("; ");
}

function createImageGenerateListActionResult(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): MediaGenerateActionResult {
  const providers = listRuntimeImageGenerationProviders({ config: params.cfg });
  return createMediaGenerateProviderListActionResult({
    kind: "image_generation",
    providers,
    emptyText: "No image-generation providers are registered.",
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    listModes: listSupportedImageGenerationModes,
    summarizeCapabilities: summarizeImageGenerationCapabilities,
    formatAuthHint: formatImageGenerationAuthHint,
  });
}

export function resolveImageGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    modelConfig: params.cfg?.agents?.defaults?.imageGenerationModel,
    providers: () => listRuntimeImageGenerationProviders({ config: params.cfg }),
  });
}

function hasExplicitImageGenerationModelConfig(cfg?: OpenClawConfig): boolean {
  return hasToolModelConfig(coerceToolModelConfig(cfg?.agents?.defaults?.imageGenerationModel));
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

function normalizeQuality(raw: string | undefined): ImageGenerationQuality | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_QUALITIES as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationQuality;
  }
  throw new ToolInputError("quality must be one of low, medium, high, or auto");
}

function normalizeOutputFormat(raw: string | undefined): ImageGenerationOutputFormat | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOutputFormat;
  }
  throw new ToolInputError("outputFormat must be one of png, jpeg, or webp");
}

function normalizeOpenAIBackground(
  raw: string | undefined,
): ImageGenerationOpenAIBackground | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_BACKGROUNDS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOpenAIBackground;
  }
  throw new ToolInputError("openai.background must be one of transparent, opaque, or auto");
}

function normalizeBackground(raw: string | undefined): ImageGenerationBackground | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_BACKGROUNDS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationBackground;
  }
  throw new ToolInputError("background must be one of transparent, opaque, or auto");
}

function normalizeOpenAIModeration(
  raw: string | undefined,
): ImageGenerationOpenAIModeration | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_OPENAI_MODERATIONS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOpenAIModeration;
  }
  throw new ToolInputError("openai.moderation must be one of low or auto");
}

function readRecordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = params[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function normalizeOpenAIOptions(args: Record<string, unknown>): ImageGenerationOpenAIOptions {
  const raw = readRecordParam(args, "openai");
  const background = normalizeOpenAIBackground(readStringParam(raw, "background"));
  const moderation = normalizeOpenAIModeration(readStringParam(raw, "moderation"));
  const outputCompression = readNumberParam(raw, "outputCompression", { integer: true });
  const user = readStringParam(raw, "user");
  if (outputCompression !== undefined && (outputCompression < 0 || outputCompression > 100)) {
    throw new ToolInputError("openai.outputCompression must be between 0 and 100");
  }
  return {
    ...(background ? { background } : {}),
    ...(moderation ? { moderation } : {}),
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    ...(user ? { user } : {}),
  };
}

function normalizeProviderOptions(
  args: Record<string, unknown>,
): ImageGenerationProviderOptions | undefined {
  const openai = normalizeOpenAIOptions(args);
  return Object.keys(openai).length > 0 ? { openai } : undefined;
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
  return `${override.key}=${sanitizeInlineDirectiveText(override.value)}`;
}

function sanitizeInlineDirectiveText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        sanitized += "\\\\";
        break;
      case "\r":
        sanitized += "\\r";
        break;
      case "\n":
        sanitized += "\\n";
        break;
      case "\t":
        sanitized += "\\t";
        break;
      default:
        if (isInlineDirectiveControlCharacter(char)) {
          sanitized += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          sanitized += char;
        }
    }
  }
  return sanitized;
}

function isInlineDirectiveControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
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
  ssrfPolicy?: SsrFPolicy;
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
    const imageRaw = normalizeMediaReferenceSource(
      trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed,
    );
    if (!imageRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const refInfo = classifyMediaReferenceSource(imageRaw);
    const { isDataUrl, isHttpUrl } = refInfo;
    if (refInfo.hasUnsupportedScheme) {
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
            ssrfPolicy: params.ssrfPolicy,
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
  authProfileStore?: AuthProfileStore;
  workspaceDir?: string;
  sandbox?: ImageGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null {
  const cfg = options?.config ?? getRuntimeConfig();
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.imageGenerationModel,
      providerKey: "imageGenerationProviders",
    })
  ) {
    return null;
  }
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
      'Generate new images or edit reference images with the configured or inferred image-generation model. For transparent backgrounds, use outputFormat="png" or "webp" and background="transparent"; OpenAI also accepts openai.background and OpenClaw routes the default OpenAI image model to gpt-image-1.5 for that mode. Set agents.defaults.imageGenerationModel.primary to pick a provider/model. Providers declare their own auth/readiness; use action="list" to inspect registered providers, models, readiness, and auth hints. Generated images are delivered automatically from the tool result as MEDIA paths.',
    parameters: ImageGenerateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = resolveAction(params);
      if (action === "list") {
        return createImageGenerateListActionResult({
          cfg,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      const imageGenerationModelConfig = resolveImageGenerationModelConfigForTool({
        cfg,
        agentDir: options?.agentDir,
        authStore: options?.authProfileStore,
      });
      if (!imageGenerationModelConfig) {
        throw new ToolInputError("No image-generation model configured.");
      }
      const explicitModelConfig = hasExplicitImageGenerationModelConfig(cfg);
      const effectiveCfg =
        applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) ?? cfg;
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
      const prompt = readStringParam(params, "prompt", { required: true });
      const imageInputs = normalizeReferenceImages(params);
      const model = readStringParam(params, "model");
      const filename = readStringParam(params, "filename");
      const size = readStringParam(params, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(params, "aspectRatio"));
      const explicitResolution = normalizeResolution(readStringParam(params, "resolution"));
      const timeoutMs = readGenerationTimeoutMs(params) ?? imageGenerationModelConfig.timeoutMs;
      const quality = normalizeQuality(readStringParam(params, "quality"));
      const outputFormat = normalizeOutputFormat(readStringParam(params, "outputFormat"));
      const background = normalizeBackground(readStringParam(params, "background"));
      const providerOptions = normalizeProviderOptions(params);
      const selectedProvider = resolveSelectedImageGenerationProvider({
        config: effectiveCfg,
        imageGenerationModelConfig,
        modelOverride: model,
      });
      const count = resolveRequestedCount(params);
      const configuredMediaMaxBytes = resolveConfiguredMediaMaxBytes(effectiveCfg);
      const mediaMaxBytes = resolveGeneratedMediaMaxBytes(effectiveCfg, "image");
      const loadedReferenceImages = await loadReferenceImages({
        imageInputs,
        maxBytes: configuredMediaMaxBytes,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
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
        autoProviderFallback: explicitModelConfig ? false : undefined,
        size,
        aspectRatio,
        resolution,
        quality,
        outputFormat,
        background,
        count,
        inputImages,
        timeoutMs,
        providerOptions,
        ssrfPolicy: remoteMediaSsrfPolicy,
      });
      const ignoredOverrides = result.ignoredOverrides ?? [];
      const displayProvider = sanitizeInlineDirectiveText(result.provider);
      const displayModel = sanitizeInlineDirectiveText(result.model);
      const warning =
        ignoredOverrides.length > 0
          ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides.map(formatIgnoredImageGenerationOverride).join(", ")}.`
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
            mediaMaxBytes,
            filename || image.fileName,
          ),
        ),
      );

      const revisedPrompts = result.images
        .map((image) => image.revisedPrompt?.trim())
        .filter((entry): entry is string => Boolean(entry));
      const lines = [
        `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
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
          ...(quality ? { quality } : {}),
          ...(outputFormat ? { outputFormat } : {}),
          ...(background ? { background } : {}),
          ...(filename ? { filename } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
