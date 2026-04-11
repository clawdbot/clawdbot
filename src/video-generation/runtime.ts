import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
import { parseVideoGenerationModelRef } from "./model-ref.js";
import { resolveVideoGenerationOverrides } from "./normalization.js";
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationResolution,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "./types.js";

const log = createSubsystemLogger("video-generation");

export type GenerateVideoParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
};

export type GenerateVideoRuntimeResult = {
  videos: GeneratedVideoAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: VideoGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
};

function buildNoVideoGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "video-generation",
    modelConfigKey: "videoGenerationModel",
    providers: listVideoGenerationProviders(cfg),
  });
}

export function listRuntimeVideoGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listVideoGenerationProviders(params?.config);
}

export async function generateVideo(
  params: GenerateVideoParams,
): Promise<GenerateVideoRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.videoGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
    agentDir: params.agentDir,
    listProviders: listVideoGenerationProviders,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoVideoGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getVideoGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No video-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveVideoGenerationOverrides({
        provider,
        model: candidate.model,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        durationSeconds: params.durationSeconds,
        audio: params.audio,
        watermark: params.watermark,
        inputImageCount: params.inputImages?.length ?? 0,
        inputVideoCount: params.inputVideos?.length ?? 0,
      });
      const result: VideoGenerationResult = await provider.generateVideo({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        durationSeconds: sanitized.durationSeconds,
        audio: sanitized.audio,
        watermark: sanitized.watermark,
        inputImages: params.inputImages,
        inputVideos: params.inputVideos,
      });
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      return {
        videos: result.videos,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        normalization: sanitized.normalization,
        ignoredOverrides: sanitized.ignoredOverrides,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            normalization: sanitized.normalization,
            requestedSizeForDerivedAspectRatio: params.size,
            includeSupportedDurationSeconds: true,
          }),
        },
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
      log.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  return throwCapabilityGenerationFailure({
    capabilityLabel: "video generation",
    attempts,
    lastError,
  });
}
