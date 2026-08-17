/** Runtime entrypoint for image generation with provider fallback and override normalization. */
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseImageGenerationModelRef } from "../media-generation/model-ref.js";
import {
  getImageGenerationProvider,
  listImageGenerationProviders,
} from "../media-generation/registry.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  resolveMediaProviderRequestTimeoutMs,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { resolveImageGenerationMaxInputImages } from "./capabilities.js";
import { resolveProviderWithModelCapabilities } from "./capability-overlays.js";
import { resolveImageGenerationOverrides } from "./normalization.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
import type { ImageGenerationResult } from "./types.js";

const log = createSubsystemLogger("image-generation");

// Discovery hooks run on the request path; bound them well below generation timeouts
// so a slow catalog lookup degrades to static caps instead of stalling the request.
const MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS = 10_000;

// Runtime dependency seam for tests and plugin-host callers. Production uses
// the plugin registry and provider-env helpers by default.
/** Dependency seam used by image-generation runtime tests and plugin host callers. */
type ImageGenerationRuntimeDeps = {
  getProvider?: typeof getImageGenerationProvider;
  listProviders?: typeof listImageGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVars;
  log?: Pick<typeof log, "debug" | "warn">;
};

export type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";

function buildNoImageGenerationModelConfiguredMessage(
  cfg: OpenClawConfig,
  deps: ImageGenerationRuntimeDeps,
): string {
  const listProviders = deps.listProviders ?? listImageGenerationProviders;
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "image-generation",
    modelConfigKey: "mediaModels.image",
    providers: listProviders(cfg),
    getProviderEnvVars: deps.getProviderEnvVars,
  });
}

/** Lists image-generation providers visible for the current config. */
export function listRuntimeImageGenerationProviders(
  params?: { config?: OpenClawConfig },
  deps: ImageGenerationRuntimeDeps = {},
) {
  return (deps.listProviders ?? listImageGenerationProviders)(params?.config);
}

export async function generateImage(
  params: GenerateImageParams,
  deps: ImageGenerationRuntimeDeps = {},
): Promise<GenerateImageRuntimeResult> {
  const getProvider = deps.getProvider ?? getImageGenerationProvider;
  const listProviders = deps.listProviders ?? listImageGenerationProviders;
  const logger = deps.log ?? log;
  const requestedTimeoutMs =
    params.timeoutMs ??
    resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.mediaModels?.image);
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.mediaModels?.image,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
    agentDir: params.agentDir,
    listProviders,
    autoProviderFallback: params.autoProviderFallback,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg, deps));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  // Try configured/fallback models in order and return the first provider whose
  // entire image batch is present and non-empty; preserve failed attempts for diagnostics.
  for (const candidate of candidates) {
    const provider = getProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      logger.warn(
        `image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${error}`,
      );
      continue;
    }

    // Overlay discovered per-model caps before ANY capability gate — the
    // maxInputImages check below and the geometry sanitizer both must see them.
    const activeProvider = await resolveProviderWithModelCapabilities({
      provider,
      providerId: candidate.provider,
      model: candidate.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore: params.authStore,
      timeoutMs: MODEL_CAPABILITY_LOOKUP_TIMEOUT_MS,
      log: logger,
    });

    const inputImageCount = params.inputImages?.length ?? 0;
    const maxInputImages = resolveImageGenerationMaxInputImages({
      provider: activeProvider,
      model: candidate.model,
    });
    if (maxInputImages !== undefined && inputImageCount > maxInputImages) {
      const error = `${candidate.provider}/${candidate.model} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}, ${inputImageCount} requested`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      logger.warn(`image-generation candidate skipped: ${error}`);
      continue;
    }

    try {
      const timeoutMs = resolveMediaProviderRequestTimeoutMs({
        timeoutMs: requestedTimeoutMs,
        providerDefaultTimeoutMs: activeProvider.defaultTimeoutMs,
      });
      const modelResolutions =
        activeProvider.capabilities.geometry?.resolutionsByModel?.[candidate.model];
      const modeCapabilities = params.inputImages?.length
        ? activeProvider.capabilities.edit
        : activeProvider.capabilities.generate;
      const inferredResolution =
        modeCapabilities.supportsResolution === false || modelResolutions?.length === 0
          ? undefined
          : params.inferredResolution;
      const sanitized = resolveImageGenerationOverrides({
        provider: activeProvider,
        model: candidate.model,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution ?? inferredResolution,
        quality: params.quality,
        outputFormat: params.outputFormat,
        background: params.background,
        inputImages: params.inputImages,
      });
      // Providers receive only supported overrides. Ignored/normalized values
      // are returned to callers so user-facing replies can explain adjustments.
      const result: ImageGenerationResult = await activeProvider.generateImage({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        count: params.count,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        quality: sanitized.quality,
        outputFormat: sanitized.outputFormat,
        background: sanitized.background,
        inputImages: params.inputImages,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        providerOptions: params.providerOptions,
        ssrfPolicy: params.ssrfPolicy,
      });
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }
      const emptyImageIndex = result.images.findIndex((image) => image.buffer.byteLength === 0);
      if (emptyImageIndex >= 0) {
        throw new Error(
          `Image generation provider returned an empty image buffer at index ${emptyImageIndex}.`,
        );
      }
      return {
        images: result.images,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        ...(sanitized.resolution ? { appliedResolution: sanitized.resolution } : {}),
        normalization: sanitized.normalization,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            normalization: sanitized.normalization,
            requestedSizeForDerivedAspectRatio: params.size,
          }),
        },
        ignoredOverrides: sanitized.ignoredOverrides,
      };
    } catch (err) {
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? formatErrorMessage(err),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      logger.warn(
        `image-generation candidate failed: ${candidate.provider}/${candidate.model}: ${
          described?.message ?? formatErrorMessage(err)
        }`,
      );
    }
  }

  return throwCapabilityGenerationFailure({
    capabilityLabel: "image generation",
    attempts,
    lastError,
  });
}
