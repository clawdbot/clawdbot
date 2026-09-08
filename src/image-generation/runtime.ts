/** Runtime entrypoint for image generation with provider fallback and override normalization. */
import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { resolveImageGenerationMaxInputImages } from "./capabilities.js";
import { resolveImageGenerationOverrides } from "./normalization.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
import type { ImageGenerationResult } from "./types.js";

const log = createSubsystemLogger("image-generation");

// Runtime dependency seam for tests and plugin-host callers. Production uses
// the plugin registry and provider-env helpers by default.
/** Dependency seam used by image-generation runtime tests and plugin host callers. */
type ImageGenerationRuntimeDeps = {
  getProvider?: typeof getImageGenerationProvider;
  listProviders?: typeof listImageGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVars;
  log?: Pick<typeof log, "warn">;
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

  return runMediaGenerationCandidates({
    candidates,
    capability: "image",
    getProvider: (providerId) => getProvider(providerId, params.cfg),
    includeSkipFailureDetails: true,
    onMissingProvider: (attempt) => {
      logger.warn(
        `image-generation candidate failed: ${attempt.provider}/${attempt.model}: ${attempt.error}`,
      );
    },
    onFailure: (attempt) => {
      logger.warn(
        `image-generation candidate failed: ${attempt.provider}/${attempt.model}: ${attempt.error}`,
      );
    },
    prepareCandidate(candidate, provider) {
      const inputImageCount = params.inputImages?.length ?? 0;
      const maxInputImages = resolveImageGenerationMaxInputImages({
        provider,
        model: candidate.model,
      });
      const referenceImageError = resolveReferenceImageCapabilityError({
        candidateRef: `${candidate.provider}/${candidate.model}`,
        inputImageCount,
        edit: {
          enabled: provider.capabilities.edit.enabled,
          ...(maxInputImages !== undefined ? { maxInputImages } : {}),
        },
      });
      if (referenceImageError) {
        logger.warn(`image-generation candidate skipped: ${referenceImageError}`);
        return referenceImageError;
      }

      return async (attempts): Promise<GenerateImageRuntimeResult> => {
        const timeoutMs = resolveMediaProviderRequestTimeoutMs({
          timeoutMs: requestedTimeoutMs,
          providerDefaultTimeoutMs: provider.defaultTimeoutMs,
        });
        const modelResolutions =
          provider.capabilities.geometry?.resolutionsByModel?.[candidate.model];
        const modeCapabilities = params.inputImages?.length
          ? provider.capabilities.edit
          : provider.capabilities.generate;
        const inferredResolution =
          modeCapabilities.supportsResolution === false || modelResolutions?.length === 0
            ? undefined
            : params.inferredResolution;
        const sanitized = resolveImageGenerationOverrides({
          provider,
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
        const result: ImageGenerationResult = await provider.generateImage({
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
      };
    },
  });
}
