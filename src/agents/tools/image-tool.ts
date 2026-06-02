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
import {
  buildMediaUnderstandingRegistry as buildProviderRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import { resolveTimeoutMs } from "../../media-understanding/resolve.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import type {
  ImageCompressionModelPolicy,
  ImageCompressionPolicy,
  WebMediaResult,
} from "../../media/web-media.js";
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveUserPath } from "../../utils.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { resolveModelAsync } from "../embedded-agent-runner/model.js";
import {
  bundledStaticCatalogProviderUsesRuntimeAugment,
  resolveBundledStaticCatalogModel,
} from "../embedded-agent-runner/model.static-catalog.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import {
  resolveImageFallbackCandidates,
  resolveImageFallbackDefaultProvider,
} from "../model-fallback.js";
import { optionalFiniteNumberSchema, optionalPositiveIntegerSchema } from "../schema/typebox.js";
import { readFiniteNumberParam, readPositiveIntegerParam } from "./common.js";
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
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveMediaToolInboundRoots,
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

type ImageToolLoadWebMediaOptions = {
  maxBytes?: number;
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
  imageCompression?: ImageCompressionPolicy;
  localRoots?: readonly string[] | "any";
  inboundRoots?: readonly string[];
  ssrfPolicy?: ReturnType<typeof resolveRemoteMediaSsrfPolicy>;
  readIdleTimeoutMs?: number;
};

type ImageWebMediaRuntime = {
  loadWebMedia: (
    mediaUrl: string,
    options?: ImageToolLoadWebMediaOptions,
  ) => Promise<WebMediaResult>;
  optimizeImageBufferForWebMedia: (typeof import("../../media/web-media.js"))["optimizeImageBufferForWebMedia"];
};

async function loadImageWebMediaRuntime(): Promise<ImageWebMediaRuntime> {
  return await import("../../media/web-media.js");
}

const imageToolProviderDeps = {
  buildProviderRegistry,
  getMediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveBundledStaticCatalogModel,
  resolveModelAsync,
  resolveImageCompressionPolicy,
  loadImageWebMediaRuntime,
};

function hasExplicitDefaultPrimaryModel(cfg?: OpenClawConfig): boolean {
  const model = cfg?.agents?.defaults?.model;
  if (typeof model === "string") {
    return model.trim().length > 0;
  }
  return typeof model?.primary === "string" && model.primary.trim().length > 0;
}

function modelRefProvider(candidate: string | null | undefined): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed?.includes("/")) {
    return undefined;
  }
  return trimmed.slice(0, trimmed.indexOf("/")).trim();
}

function isExecutionAliasCandidateForProvider(
  candidate: string | null | undefined,
  provider: string,
): boolean {
  const candidateProvider = modelRefProvider(candidate);
  return Boolean(
    candidateProvider &&
    candidateProvider !== normalizeMediaProviderId(candidateProvider) &&
    normalizeMediaProviderId(candidateProvider) === normalizeMediaProviderId(provider),
  );
}

function isCanonicalCandidateShadowedByExecutionAlias(
  candidate: string | null | undefined,
  candidates: readonly (string | null | undefined)[],
): boolean {
  const candidateProvider = modelRefProvider(candidate);
  if (!candidateProvider || candidateProvider !== normalizeMediaProviderId(candidateProvider)) {
    return false;
  }
  if (!isMinimaxVlmProvider(candidateProvider)) {
    return false;
  }
  return candidates.some((shadowCandidate) =>
    isExecutionAliasCandidateForProvider(shadowCandidate, candidateProvider),
  );
}

export const testing = {
  decodeDataUrl,
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
  resolveImageToolMaxTokens,
  resolveImageCompressionPolicy,
  setProviderDepsForTest(overrides?: {
    buildProviderRegistry?: typeof buildProviderRegistry;
    getMediaUnderstandingProvider?: typeof getMediaUnderstandingProvider;
    describeImageWithModel?: typeof describeImageWithModel;
    describeImagesWithModel?: typeof describeImagesWithModel;
    resolveAutoMediaKeyProviders?: typeof resolveAutoMediaKeyProviders;
    resolveDefaultMediaModel?: typeof resolveDefaultMediaModel;
    resolveBundledStaticCatalogModel?: typeof resolveBundledStaticCatalogModel;
    resolveModelAsync?: typeof resolveModelAsync;
    resolveImageCompressionPolicy?: typeof resolveImageCompressionPolicy;
    loadImageWebMediaRuntime?: typeof loadImageWebMediaRuntime;
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
    imageToolProviderDeps.resolveBundledStaticCatalogModel =
      overrides?.resolveBundledStaticCatalogModel ?? resolveBundledStaticCatalogModel;
    imageToolProviderDeps.resolveModelAsync = overrides?.resolveModelAsync ?? resolveModelAsync;
    imageToolProviderDeps.resolveImageCompressionPolicy =
      overrides?.resolveImageCompressionPolicy ?? resolveImageCompressionPolicy;
    imageToolProviderDeps.loadImageWebMediaRuntime =
      overrides?.loadImageWebMediaRuntime ?? loadImageWebMediaRuntime;
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
  workspaceDir?: string;
  authStore?: AuthProfileStore;
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
      workspaceDir: params.workspaceDir,
      providerId: primary.provider,
      capability: "image",
      includeConfiguredImageModels: !isMinimaxVlmProvider(primary.provider),
    });
    if (providerDefault) {
      return [`${primary.provider}/${providerDefault}`];
    }
    if (isMinimaxVlmProvider(primary.provider)) {
      return [`${primary.provider}/MiniMax-VL-01`];
    }
    return [];
  })();

  const rawAutoCandidates = imageToolProviderDeps
    .resolveAutoMediaKeyProviders({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      capability: "image",
    })
    .map((providerId) => {
      const modelId = imageToolProviderDeps.resolveDefaultMediaModel({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId,
        capability: "image",
        includeConfiguredImageModels: !isMinimaxVlmProvider(providerId),
      });
      return modelId ? `${providerId}/${modelId}` : null;
    });
  const autoCandidates = rawAutoCandidates.filter(
    (candidate) =>
      !isCanonicalCandidateShadowedByExecutionAlias(candidate, [
        ...primaryCandidates,
        ...rawAutoCandidates,
      ]),
  );
  const defaultPrimaryIsImplicit = !hasExplicitDefaultPrimaryModel(params.cfg);
  const primaryAliasCandidates = defaultPrimaryIsImplicit
    ? autoCandidates.filter((candidate) =>
        isExecutionAliasCandidateForProvider(candidate, primary.provider),
      )
    : [];
  const remainingAutoCandidates =
    primaryAliasCandidates.length === 0
      ? autoCandidates
      : autoCandidates.filter((candidate) => !primaryAliasCandidates.includes(candidate));

  return buildToolModelConfigFromCandidates({
    explicit,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    candidates: [...primaryAliasCandidates, ...primaryCandidates, ...remainingAutoCandidates],
  });
}

function resolveImageModelConfigForOverride(params: {
  cfg?: OpenClawConfig;
  modelOverride?: string;
}): ImageModelConfig | null {
  const model = params.modelOverride?.trim();
  if (!model) {
    return null;
  }
  return resolveConfiguredImageModelRefs({
    cfg: params.cfg,
    imageModelConfig: { primary: model },
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

function resolveCompressionModelCandidates(params: {
  cfg?: OpenClawConfig;
  imageModelConfig?: ImageModelConfig | null;
  modelOverride?: string;
}): Array<{ provider: string; model: string }> {
  const overrideConfig = resolveImageModelConfigForOverride({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });
  const configuredImageModelConfig = params.imageModelConfig
    ? resolveConfiguredImageModelRefs({
        cfg: params.cfg,
        imageModelConfig: params.imageModelConfig,
      })
    : null;
  const effectiveImageModelConfig = overrideConfig ?? configuredImageModelConfig;
  const effectiveCfg = effectiveImageModelConfig
    ? applyImageModelConfigDefaults(params.cfg, effectiveImageModelConfig)
    : params.cfg;
  return resolveImageFallbackCandidates({
    cfg: effectiveCfg,
    defaultProvider: resolveImageFallbackDefaultProvider(effectiveCfg),
  });
}

function imageCompressionPolicyHasDimensionLimit(policy: ImageCompressionModelPolicy): boolean {
  return typeof policy.maxSidePx === "number" || typeof policy.maxPixels === "number";
}

function mergeImageCompressionPolicies(params: {
  runtimePolicy: ImageCompressionModelPolicy;
  staticPolicy: ImageCompressionModelPolicy;
}): ImageCompressionModelPolicy {
  return {
    ...params.runtimePolicy,
    ...params.staticPolicy,
  };
}

function resolveBundledStaticCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  workspaceDir?: string;
}): ImageCompressionModelPolicy {
  const model = imageToolProviderDeps.resolveBundledStaticCatalogModel({
    provider: params.provider,
    modelId: params.model,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  return model?.mediaInput?.image ?? {};
}

function providerUsesRuntimeModelAugment(params: {
  cfg?: OpenClawConfig;
  provider: string;
  workspaceDir?: string;
}): boolean {
  const provider = normalizeMediaProviderId(params.provider);
  if (!provider) {
    return false;
  }
  if (bundledStaticCatalogProviderUsesRuntimeAugment({ provider })) {
    return true;
  }
  const config = params.cfg ?? {};
  const snapshot = loadManifestMetadataSnapshot({
    config,
    env: process.env,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  return snapshot.plugins.some((plugin) => {
    const ownsProvider =
      plugin.providers.some((candidate) => normalizeMediaProviderId(candidate) === provider) ||
      Boolean(plugin.modelCatalog?.providers?.[provider]);
    if (!ownsProvider) {
      return false;
    }
    const runtimeAugment =
      plugin.modelCatalog?.runtimeAugment === true ||
      (plugin.origin !== "bundled" &&
        plugin.providers.some((candidate) => normalizeMediaProviderId(candidate) === provider));
    if (!runtimeAugment) {
      return false;
    }
    return isManifestPluginAvailableForControlPlane({
      snapshot,
      plugin,
      config,
    });
  });
}

async function resolveCompressionModelPolicyWithHooks(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  skipProviderRuntimeHooks: boolean;
}): Promise<ImageCompressionModelPolicy> {
  try {
    const resolved = await imageToolProviderDeps.resolveModelAsync(
      params.provider,
      params.model,
      params.agentDir,
      params.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        skipProviderRuntimeHooks: params.skipProviderRuntimeHooks,
        skipAgentDiscovery: true,
        workspaceDir: params.workspaceDir,
      },
    );
    return (resolved.model as ProviderRuntimeModel | undefined)?.mediaInput?.image ?? {};
  } catch {
    return {};
  }
}

async function resolveCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ImageCompressionModelPolicy> {
  const configuredStaticPolicy = await resolveCompressionModelPolicyWithHooks({
    ...params,
    skipProviderRuntimeHooks: true,
  });
  const staticPolicy = mergeImageCompressionPolicies({
    runtimePolicy: resolveBundledStaticCompressionModelPolicy(params),
    staticPolicy: configuredStaticPolicy,
  });
  if (
    imageCompressionPolicyHasDimensionLimit(staticPolicy) ||
    !providerUsesRuntimeModelAugment({
      cfg: params.cfg,
      provider: params.provider,
      workspaceDir: params.workspaceDir,
    })
  ) {
    return staticPolicy;
  }
  const runtimePolicy = await resolveCompressionModelPolicyWithHooks({
    ...params,
    skipProviderRuntimeHooks: false,
  });
  return mergeImageCompressionPolicies({ runtimePolicy, staticPolicy });
}

async function resolveImageCompressionPolicy(params: {
  cfg?: OpenClawConfig;
  imageModelConfig?: ImageModelConfig | null;
  modelOverride?: string;
  imageCount: number;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ImageCompressionPolicy> {
  const modelCandidates = resolveCompressionModelCandidates(params);
  const quality = params.cfg?.agents?.defaults?.imageQuality;
  const models: ImageCompressionModelPolicy[] = await Promise.all(
    modelCandidates.map(async (candidate): Promise<ImageCompressionModelPolicy> => {
      return resolveCompressionModelPolicy({
        cfg: params.cfg,
        provider: candidate.provider,
        model: candidate.model,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
    }),
  );
  return {
    imageCount: params.imageCount,
    ...(models.length > 0 ? { models } : {}),
    ...(quality ? { quality } : {}),
  };
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
  workspaceDir?: string;
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
        providerRegistry,
      });
      const imageProvider = imageToolProviderDeps.getMediaUnderstandingProvider(
        provider,
        providerRegistry,
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
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
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
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
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
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
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
  authProfileStore?: AuthProfileStore;
  workspaceDir?: string;
  sandbox?: ImageSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  agentChannel?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  /** If true, the model has native vision capability and images in the prompt are auto-injected */
  modelHasVision?: boolean;
  /**
   * Avoid resolving auto image-provider/model candidates while registering the
   * tool. The concrete image model is still resolved before execution.
   */
  deferAutoModelResolution?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  const explicit = coerceImageModelConfig(options?.config);
  if (!agentDir) {
    if (hasToolModelConfig(explicit)) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const explicitImageModelConfig = hasToolModelConfig(explicit)
    ? resolveConfiguredImageModelRefs({
        cfg: options?.config,
        imageModelConfig: explicit,
      })
    : null;
  const shouldResolveAutoImageModel =
    !explicitImageModelConfig && !options?.deferAutoModelResolution;
  const resolvedImageModelConfig = shouldResolveAutoImageModel
    ? resolveImageModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
      })
    : explicitImageModelConfig;
  if (!resolvedImageModelConfig && !options?.deferAutoModelResolution) {
    return null;
  }
  const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(options?.config);

  // If model has native vision, images in the prompt are auto-injected
  // so this tool is only needed when image wasn't provided in the prompt
  const description = options?.modelHasVision
    ? "Analyze images with vision model. Use image for one path/URL, images for max 20. Only use this tool when images were NOT already provided; prompt images already visible."
    : explicitImageModelConfig
      ? "Analyze images with configured image model. Use image for one path/URL, images for max 20. Prompt says what to inspect."
      : "Analyze images with available vision model. Use image for one path/URL, images for max 20. Prompt says what to inspect.";

  return {
    label: "Image",
    name: "image",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      image: Type.Optional(Type.String({ description: "One image path/URL." })),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description: "Image paths/URLs; maxImages default 20.",
        }),
      ),
      model: Type.Optional(Type.String()),
      maxBytesMb: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
      maxImages: optionalPositiveIntegerSchema(),
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
      const maxImages = readPositiveIntegerParam(record, "maxImages") ?? DEFAULT_MAX_IMAGES;
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
      const maxBytesMb = readFiniteNumberParam(record, "maxBytesMb", {
        min: 0,
        minExclusive: true,
        message: "maxBytesMb must be greater than 0",
      });
      const maxBytes = pickMaxBytes(options?.config, maxBytesMb);
      const imageModelConfig =
        resolvedImageModelConfig ??
        resolveImageModelConfigForOverride({
          cfg: options?.config,
          modelOverride,
        }) ??
        resolveImageModelConfigForTool({
          cfg: options?.config,
          agentDir,
          workspaceDir: options?.workspaceDir,
          authStore: options?.authProfileStore,
        });
      if (!imageModelConfig) {
        throw new Error(
          "No image model is configured. Set agents.defaults.imageModel or configure an image-capable provider.",
        );
      }
      const imageCompression = await imageToolProviderDeps.resolveImageCompressionPolicy({
        cfg: options?.config,
        imageModelConfig,
        modelOverride,
        imageCount: imageInputs.length,
        agentDir,
        workspaceDir: options?.workspaceDir,
      });

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
        const { isDataUrl, isFileUrl, isHttpUrl, isMediaStoreUrl } = refInfo;
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
            !isMediaStoreUrl &&
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
            cfg: options?.config,
            channelId: options?.agentChannel ?? options?.currentChannelId,
            accountId: options?.agentAccountId,
          },
          resolvedPath ? [resolvedPath] : undefined,
        );
        const mediaInboundRoots = resolveMediaToolInboundRoots({
          workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
          cfg: options?.config,
          channelId: options?.agentChannel ?? options?.currentChannelId,
          accountId: options?.agentAccountId,
        });
        const imageWebMedia = await imageToolProviderDeps.loadImageWebMediaRuntime();

        const media = isDataUrl
          ? await (async () => {
              const decoded = decodeDataUrl(resolvedImage, { maxBytes });
              return await imageWebMedia.optimizeImageBufferForWebMedia({
                buffer: decoded.buffer,
                contentType: decoded.mimeType,
                maxBytes,
                imageCompression,
              });
            })()
          : sandboxConfig
            ? await imageWebMedia.loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                sandboxValidated: true,
                readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
                imageCompression,
              })
            : await imageWebMedia.loadWebMedia(resolvedPath ?? resolvedImage, {
                maxBytes,
                localRoots: mediaLocalRoots,
                inboundRoots: mediaInboundRoots,
                ssrfPolicy: remoteMediaSsrfPolicy,
                ...(isHttpUrl ? { readIdleTimeoutMs: REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS } : {}),
                imageCompression,
              });
        if (media.kind !== "image") {
          throw new Error(`Unsupported media type: ${media.kind}`);
        }

        const contentType =
          "contentType" in media && typeof media.contentType === "string"
            ? media.contentType
            : undefined;
        const legacyMimeType =
          "mimeType" in media && typeof media.mimeType === "string" ? media.mimeType : undefined;
        const mimeType = contentType ?? legacyMimeType ?? "image/png";
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
        workspaceDir: options?.workspaceDir,
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
export { testing as __testing };
