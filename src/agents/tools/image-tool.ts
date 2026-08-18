import { resolve, isAbsolute } from "node:path";
import { Type } from "typebox";
import { findCapabilityProviderById } from "../../../packages/media-generation-core/src/capability-model-ref.js";
import { normalizeMediaProviderId } from "../../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaUnderstandingModelConfig } from "../../config/types.tools.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import { matchesMediaEntryCapability } from "../../media-understanding/entry-capabilities.js";
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
import { resolvePluginCapabilityProvider } from "../../plugins/capability-provider-runtime.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveUserPath } from "../../utils.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { bundledStaticCatalogProviderUsesRuntimeAugment } from "../embedded-agent-runner/model.static-catalog.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import {
  resolveImageFallbackCandidates,
  resolveImageFallbackDefaultProvider,
} from "../model-fallback-candidates.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
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
  buildImageToolReferenceDetails,
  buildNativeImageToolResult,
  type LoadedImageForTool,
} from "./image-tool.result.js";
import {
  applyImageModelConfigDefaults,
  buildTextToolResult,
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveMediaToolInboundRoots,
  resolveMediaToolReferenceAccess,
  resolveRemoteMediaSsrfPolicy,
  resolvePromptAndModelOverride,
} from "./media-tool-shared.js";
import {
  buildToolModelConfigFromCandidates,
  hasToolModelConfig,
  resolveDefaultModelRef,
  resolveOpenAiImageMediaCandidate,
} from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
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
  requestInit?: RequestInit;
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

type ResolveModelAsync = (typeof import("../embedded-agent-runner/model.js"))["resolveModelAsync"];

const resolveModelAsyncDefault: ResolveModelAsync = async (...args) => {
  const { resolveModelAsync } = await import("../embedded-agent-runner/model.js");
  return await resolveModelAsync(...args);
};

function resolveRegisteredMediaUnderstandingProvider(params: {
  providerId: string;
  cfg?: OpenClawConfig;
}): MediaUnderstandingProvider | undefined {
  return resolvePluginCapabilityProvider({
    key: "mediaUnderstandingProviders",
    providerId: params.providerId,
    cfg: params.cfg,
  });
}

const imageToolProviderDeps = {
  buildProviderRegistry,
  getMediaUnderstandingProvider,
  describeImageWithModel,
  describeImagesWithModel,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveModelAsync: resolveModelAsyncDefault,
  resolveRegisteredMediaUnderstandingProvider,
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

const testing = {
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
    resolveModelAsync?: ResolveModelAsync;
    resolveRegisteredMediaUnderstandingProvider?: typeof resolveRegisteredMediaUnderstandingProvider;
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
    imageToolProviderDeps.resolveModelAsync =
      overrides?.resolveModelAsync ?? resolveModelAsyncDefault;
    imageToolProviderDeps.resolveRegisteredMediaUnderstandingProvider =
      overrides?.resolveRegisteredMediaUnderstandingProvider ??
      resolveRegisteredMediaUnderstandingProvider;
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
 * Resolve the effective image model config for the `view_image` tool.
 *
 * - Prefer explicit config (`agents.defaults.imageModel`).
 * - Otherwise, try to "pair" the primary model with an image-capable model:
 *   - same provider (best effort)
 *   - fall back to OpenAI/Anthropic when available
 */
function resolveImageModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): ImageModelConfig | null {
  // Native-vision runs route post-prompt image bytes to the active model, not fallback config.
  const explicit = coerceImageModelConfig(params.cfg);
  if (hasToolModelConfig(explicit)) {
    return resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicit,
    });
  }

  const primary = resolveDefaultModelRef(params.cfg);
  let verifiedSubstituteProvider: string | undefined;
  const resolveCodexMediaRoute = () => {
    const preparedProviders =
      params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;
    const provider = preparedProviders
      ? findCapabilityProviderById({
          providers: preparedProviders,
          providerId: "codex",
          normalizeProviderId: normalizeMediaProviderId,
        })
      : imageToolProviderDeps.resolveRegisteredMediaUnderstandingProvider({
          providerId: "codex",
          cfg: params.cfg,
        });
    if (!provider?.capabilities?.includes("image")) {
      return undefined;
    }
    const model = imageToolProviderDeps.resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: "codex",
      capability: "image",
      providerRegistry: new Map([[provider.id, provider]]),
      includeConfiguredImageModels: false,
    });
    return model ? { model } : undefined;
  };
  const resolveImplicitOpenAiImageCandidate = (openAiModel: string): string | null => {
    const decision = resolveOpenAiImageMediaCandidate({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
      openAiModel,
      resolveCodexMediaRoute,
    });
    if (decision.kind === "substitute") {
      verifiedSubstituteProvider = decision.provider;
      return decision.ref;
    }
    return decision.kind === "keep" ? decision.ref : null;
  };

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const primaryCandidates = (() => {
    if (providerVisionFromConfig) {
      if (primary.provider === "openai") {
        return [
          resolveImplicitOpenAiImageCandidate(
            providerVisionFromConfig.slice(providerVisionFromConfig.indexOf("/") + 1),
          ),
        ];
      }
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
      if (primary.provider === "openai") {
        return [resolveImplicitOpenAiImageCandidate(providerDefault)];
      }
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
      if (!modelId) {
        return null;
      }
      return providerId === "openai"
        ? resolveImplicitOpenAiImageCandidate(modelId)
        : `${providerId}/${modelId}`;
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
    isProviderConfigured: (provider) =>
      verifiedSubstituteProvider && provider === verifiedSubstituteProvider ? true : undefined,
  });
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.imageToolTestApi")] = {
    ...testing,
    resolveImageModelConfigForTool,
  };
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

function providerUsesRuntimeModelAugment(params: {
  cfg?: OpenClawConfig;
  provider: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): boolean {
  const provider = normalizeMediaProviderId(params.provider);
  if (!provider) {
    return false;
  }
  const config = params.cfg ?? {};
  const snapshot =
    params.preparedModelRuntime?.metadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config,
      env: process.env,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    });
  if (
    bundledStaticCatalogProviderUsesRuntimeAugment({
      provider,
      cfg: params.cfg,
      ...(snapshot ? { metadataSnapshot: snapshot } : {}),
      workspaceDir: params.workspaceDir,
    })
  ) {
    return true;
  }
  if (!snapshot) {
    return false;
  }
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
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
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
        ...(params.preparedModelRuntime
          ? { preparedModelRuntime: params.preparedModelRuntime }
          : {}),
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
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): Promise<ImageCompressionModelPolicy> {
  const staticPolicy = await resolveCompressionModelPolicyWithHooks({
    ...params,
    skipProviderRuntimeHooks: true,
  });
  if (
    imageCompressionPolicyHasDimensionLimit(staticPolicy) ||
    !providerUsesRuntimeModelAugment({
      cfg: params.cfg,
      provider: params.provider,
      workspaceDir: params.workspaceDir,
      preparedModelRuntime: params.preparedModelRuntime,
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
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
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
        preparedModelRuntime: params.preparedModelRuntime,
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
    sharedEntry?.timeoutSeconds ?? params.cfg.tools?.media?.image?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS.image,
  );
}

type ImageSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function runImagePrompt(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  imageModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  images: Array<{ buffer: Buffer; mimeType: string }>;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.imageModelConfig);
  const providerCfg: OpenClawConfig = effectiveCfg ?? {};
  const preparedProviders =
    params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;
  const providerRegistry = imageToolProviderDeps.buildProviderRegistry(
    undefined,
    providerCfg,
    preparedProviders,
  );

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    abortSignal: params.signal,
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
        // A run cancelled mid-dispatch must not buy another provider call.
        params.signal?.throwIfAborted();
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
          ...(params.signal ? { signal: params.signal } : {}),
          cfg: providerCfg,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          agentDir: params.agentDir,
          authStore: params.authStore,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.preparedModelRuntime
            ? { preparedModelRuntime: params.preparedModelRuntime }
            : {}),
        });
        return { text: described.text, provider, model: described.model ?? modelId };
      }
      const describeImage =
        imageProvider?.describeImage ?? imageToolProviderDeps.describeImageWithModel;
      if (params.images.length === 1) {
        const image = params.images.at(0);
        if (!image) {
          throw new Error("Image input disappeared during model execution");
        }
        // A run cancelled mid-dispatch must not buy another provider call.
        params.signal?.throwIfAborted();
        const described = await describeImage({
          buffer: image.buffer,
          fileName: "image-1",
          mime: image.mimeType,
          provider,
          model: modelId,
          prompt: params.prompt,
          maxTokens: resolveImageToolMaxTokens(undefined),
          timeoutMs,
          ...(params.signal ? { signal: params.signal } : {}),
          cfg: providerCfg,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          agentDir: params.agentDir,
          authStore: params.authStore,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.preparedModelRuntime
            ? { preparedModelRuntime: params.preparedModelRuntime }
            : {}),
        });
        return { text: described.text, provider, model: described.model ?? modelId };
      }

      const parts: string[] = [];
      for (const [index, image] of params.images.entries()) {
        // A run cancelled mid-dispatch must not buy another provider call.
        params.signal?.throwIfAborted();
        const described = await describeImage({
          buffer: image.buffer,
          fileName: `image-${index + 1}`,
          mime: image.mimeType,
          provider,
          model: modelId,
          prompt: `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length}.`,
          maxTokens: resolveImageToolMaxTokens(undefined),
          timeoutMs,
          ...(params.signal ? { signal: params.signal } : {}),
          cfg: providerCfg,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          agentDir: params.agentDir,
          authStore: params.authStore,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.preparedModelRuntime
            ? { preparedModelRuntime: params.preparedModelRuntime }
            : {}),
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
  agentId?: string;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
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
  const modelHasVision = options?.modelHasVision === true;
  const explicit = coerceImageModelConfig(options?.config);
  if (!agentDir) {
    if (hasToolModelConfig(explicit)) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const explicitImageModelConfig =
    !modelHasVision && hasToolModelConfig(explicit)
      ? resolveConfiguredImageModelRefs({
          cfg: options?.config,
          imageModelConfig: explicit,
        })
      : null;
  const shouldResolveAutoImageModel =
    !modelHasVision && !explicitImageModelConfig && !options?.deferAutoModelResolution;
  const resolvedImageModelConfig = shouldResolveAutoImageModel
    ? resolveImageModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
        preparedModelRuntime: options?.preparedModelRuntime,
      })
    : explicitImageModelConfig;
  if (!modelHasVision && !resolvedImageModelConfig && !options?.deferAutoModelResolution) {
    return null;
  }
  const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(options?.config);

  const description = modelHasVision
    ? "Load image(s) into private model context for inspection: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user. Prompt images are already visible."
    : explicitImageModelConfig
      ? "Inspect image(s) in private model context with the configured model: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user."
      : "Inspect image(s) in private model context with available vision: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user.";

  return {
    label: "View Image",
    name: "view_image",
    description,
    ...(modelHasVision ? { catalogMode: "direct-only" as const } : {}),
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({ description: "One local image path or permitted URL." })),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Local image paths or permitted URLs; maxImages default 20.",
        }),
      ),
      ...(modelHasVision ? {} : { model: Type.Optional(Type.String()) }),
      maxBytesMb: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
      maxImages: optionalPositiveIntegerSchema(),
    }),
    execute: async (_toolCallId, args, signal) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // MARK: - Normalize path + paths input and dedupe while preserving order
      const pathCandidates: string[] = [];
      if (typeof record.path === "string") {
        pathCandidates.push(record.path);
      }
      if (Array.isArray(record.paths)) {
        pathCandidates.push(...record.paths.filter((v): v is string => typeof v === "string"));
      }

      const seenImages = new Set<string>();
      const pathInputs: string[] = [];
      for (const candidate of pathCandidates) {
        const trimmedCandidate = candidate.trim();
        const normalizedForDedupe = trimmedCandidate.startsWith("@")
          ? trimmedCandidate.slice(1).trim()
          : trimmedCandidate;
        if (!normalizedForDedupe || seenImages.has(normalizedForDedupe)) {
          continue;
        }
        seenImages.add(normalizedForDedupe);
        pathInputs.push(trimmedCandidate);
      }
      if (pathInputs.length === 0) {
        throw new Error("path required");
      }

      // MARK: - Enforce max images cap
      const maxImages = readPositiveIntegerParam(record, "maxImages") ?? DEFAULT_MAX_IMAGES;
      if (pathInputs.length > maxImages) {
        return {
          content: [
            {
              type: "text",
              text: `Too many images: ${pathInputs.length} provided, maximum is ${maxImages}. Please reduce the number of images.`,
            },
          ],
          details: { error: "too_many_images", count: pathInputs.length, max: maxImages },
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
      let imageRoute:
        | { kind: "native" }
        | {
            kind: "fallback";
            imageModelConfig: ImageModelConfig;
            imageCompression: ImageCompressionPolicy;
          };
      if (modelHasVision) {
        imageRoute = { kind: "native" };
      } else {
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
            preparedModelRuntime: options?.preparedModelRuntime,
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
          imageCount: pathInputs.length,
          agentDir,
          workspaceDir: options?.workspaceDir,
          preparedModelRuntime: options?.preparedModelRuntime,
        });
        imageRoute = { kind: "fallback", imageModelConfig, imageCompression };
      }
      const imageCompression =
        imageRoute.kind === "fallback" ? imageRoute.imageCompression : undefined;
      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options?.sandbox.root.trim()
          ? {
              root: options.sandbox.root.trim(),
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Load and resolve each image
      const loadedImages: LoadedImageForTool[] = [];

      for (const pathRawInput of pathInputs) {
        // Stop before starting the next sequential download/decode when the run
        // was aborted, so a dead run cannot keep pulling up to maxImages remote images.
        signal?.throwIfAborted();
        const trimmed = pathRawInput.trim();
        const imageRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
        if (!imageRaw) {
          throw new Error("path required (empty string in paths)");
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
                text: `Unsupported image reference: ${pathRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
              },
            ],
            details: {
              error: "unsupported_image_reference",
              path: pathRawInput,
            },
          };
        }

        if (sandboxConfig && isHttpUrl) {
          throw new Error("Sandboxed view_image does not allow remote URLs.");
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
        const {
          resolvedPath,
          localRoots: mediaLocalRoots,
          rewrittenFrom,
        } = await resolveMediaToolReferenceAccess({
          input: resolvedImage,
          isDataUrl,
          workspaceDir: options?.workspaceDir,
          sandbox: sandboxConfig,
          rootOptions: {
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
            cfg: options?.config,
            channelId: options?.agentChannel ?? options?.currentChannelId,
            accountId: options?.agentAccountId,
          },
        });
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
                // Forward the run abort signal into the fetch layer so an abort
                // mid-download disconnects the in-flight socket.
                ...(signal ? { requestInit: { signal } } : {}),
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
          ...(isHttpUrl ? { remoteSource: true } : {}),
          ...(rewrittenFrom ? { rewrittenFrom } : {}),
        });
      }

      // Per-invocation taint: only http(s) images are externally controlled
      // (a prompt-injection vector via the visual description). Local paths,
      // file://, and data: keep the default trusted classification.
      const anyRemoteImageSource = loadedImages.some((img) => img.remoteSource);

      if (imageRoute.kind === "native") {
        const nativeResult = await buildNativeImageToolResult(loadedImages, options?.config);
        return anyRemoteImageSource
          ? { ...nativeResult, resultContentSource: "network" as const }
          : nativeResult;
      }
      // Do not issue a paid vision-provider call for an already-aborted run.
      signal?.throwIfAborted();
      // Text-only runs delegate image understanding to the configured fallback model.
      const result = await runImagePrompt({
        signal,
        cfg: options?.config,
        agentId: options?.agentId,
        agentDir,
        authStore: options?.authProfileStore,
        imageModelConfig: imageRoute.imageModelConfig,
        modelOverride,
        prompt: promptRaw,
        images: loadedImages.map((img) => ({ buffer: img.buffer, mimeType: img.mimeType })),
        workspaceDir: options?.workspaceDir,
        preparedModelRuntime: options?.preparedModelRuntime,
      });

      return {
        ...buildTextToolResult(result, buildImageToolReferenceDetails(loadedImages)),
        ...(anyRemoteImageSource ? { resultContentSource: "network" as const } : {}),
      };
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
