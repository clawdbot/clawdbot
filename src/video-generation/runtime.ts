import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import { resolveVideoGenerationSupportedDurations } from "./duration-support.js";
import { parseVideoGenerationModelRef } from "./model-ref.js";
import { resolveVideoGenerationOverrides } from "./normalization.js";
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
import type { VideoGenerationProviderOptionType, VideoGenerationResult } from "./types.js";

const log = createSubsystemLogger("video-generation");
export type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";

/**
 * Validate agent-supplied providerOptions against the candidate's declared
 * schema. Returns a human-readable skip reason when the candidate cannot
 * accept the supplied options, or undefined when everything checks out.
 *
 * Backward-compatible behavior:
 * - Provider declares no schema (undefined): pass options through as-is.
 *   The provider receives them and may silently ignore unknown keys. This is
 *   the safe default for legacy / not-yet-migrated providers.
 * - Provider explicitly declares an empty schema ({}): rejects any options.
 *   This is the opt-in signal that the provider has been audited and truly
 *   supports no options.
 * - Provider declares a typed schema: validates each key name and value type,
 *   skipping the candidate on any mismatch.
 */
function validateProviderOptionsAgainstDeclaration(params: {
  providerId: string;
  model: string;
  providerOptions: Record<string, unknown>;
  declaration: Readonly<Record<string, VideoGenerationProviderOptionType>> | undefined;
}): string | undefined {
  const { providerId, model, providerOptions, declaration } = params;
  const keys = Object.keys(providerOptions);
  if (keys.length === 0) {
    return undefined;
  }
  if (declaration === undefined) {
    return undefined;
  }
  if (Object.keys(declaration).length === 0) {
    return `${providerId}/${model} does not accept providerOptions (caller supplied: ${keys.join(", ")}); skipping`;
  }
  const unknown = keys.filter((key) => !Object.hasOwn(declaration, key));
  if (unknown.length > 0) {
    const accepted = Object.keys(declaration).join(", ");
    return `${providerId}/${model} does not accept providerOptions keys: ${unknown.join(", ")} (accepted: ${accepted}); skipping`;
  }
  for (const key of keys) {
    const expected = declaration[key];
    const value = providerOptions[key];
    const actual = typeof value;
    if (expected === "number" && (actual !== "number" || !Number.isFinite(value as number))) {
      return `${providerId}/${model} expects providerOptions.${key} to be a finite number, got ${actual}; skipping`;
    }
    if (expected === "boolean" && actual !== "boolean") {
      return `${providerId}/${model} expects providerOptions.${key} to be a boolean, got ${actual}; skipping`;
    }
    if (expected === "string" && actual !== "string") {
      return `${providerId}/${model} expects providerOptions.${key} to be a string, got ${actual}; skipping`;
    }
  }
  return undefined;
}

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
  let skipWarnEmitted = false;
  const warnOnFirstSkip = (reason: string) => {
    // Skip events are common in normal fallback flow, so log the *first* one in
    // a request at warn level with the reason, and leave the rest at debug.
    // This gives the operator visible feedback that their primary provider was
    // passed over without flooding logs on long fallback chains.
    if (!skipWarnEmitted) {
      skipWarnEmitted = true;
      log.warn(`video-generation candidate skipped: ${reason}`);
    }
  };

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

    // Guard: skip candidates that cannot satisfy reference-input counts so
    // we never silently drop audio/image/video refs by falling over to a
    // provider that ignores them and "succeeds" without the caller's assets.
    const inputImageCount = params.inputImages?.length ?? 0;
    const inputVideoCount = params.inputVideos?.length ?? 0;
    const inputAudioCount = params.inputAudios?.length ?? 0;
    if (inputAudioCount > 0) {
      const { capabilities: candCaps } = resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount,
        inputVideoCount,
      });
      // Fall back to flat provider.capabilities.maxInputAudios for providers that
      // set the all-modes default directly rather than nesting it in capabilities.generate etc.
      const maxAudio = candCaps?.maxInputAudios ?? provider.capabilities.maxInputAudios ?? 0;
      if (inputAudioCount > maxAudio) {
        const error =
          maxAudio === 0
            ? `${candidate.provider}/${candidate.model} does not support reference audio inputs; skipping to avoid silent audio drop`
            : `${candidate.provider}/${candidate.model} supports at most ${maxAudio} reference audio(s), ${inputAudioCount} requested; skipping`;
        attempts.push({ provider: candidate.provider, model: candidate.model, error });
        lastError = new Error(error);
        warnOnFirstSkip(error);
        log.debug(
          `video-generation candidate skipped (audio capability): ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
    }

    // Guard: skip candidates that do not accept the requested providerOptions keys,
    // or whose declared providerOptions schema does not match the supplied value
    // types. Same skip-in-fallback rationale as the audio guard above — we never
    // want to silently forward provider-specific options to the wrong provider,
    // but we also do not want to block valid fallback candidates that *do* accept
    // them. Providers opt in by declaring `capabilities.providerOptions` on the
    // active mode or on the flat provider capabilities.
    if (
      params.providerOptions &&
      typeof params.providerOptions === "object" &&
      Object.keys(params.providerOptions).length > 0
    ) {
      const { capabilities: optCaps } = resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount,
        inputVideoCount,
      });
      const declaredOptions =
        optCaps?.providerOptions ?? provider.capabilities.providerOptions ?? undefined;
      const mismatch = validateProviderOptionsAgainstDeclaration({
        providerId: candidate.provider,
        model: candidate.model,
        providerOptions: params.providerOptions,
        declaration: declaredOptions,
      });
      if (mismatch) {
        attempts.push({ provider: candidate.provider, model: candidate.model, error: mismatch });
        lastError = new Error(mismatch);
        warnOnFirstSkip(mismatch);
        log.debug(
          `video-generation candidate skipped (providerOptions): ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
    }

    // Guard: skip candidates whose maxDurationSeconds hard cap is below the requested
    // duration. Only applies when the provider uses a simple max with no explicit
    // supported-durations list — when a list exists, runtime normalization snaps to the
    // nearest valid value so skipping is not appropriate.
    const requestedDuration = params.durationSeconds;
    if (typeof requestedDuration === "number" && Number.isFinite(requestedDuration)) {
      const { capabilities: durCaps } = resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount,
        inputVideoCount,
      });
      const supportedDurations = resolveVideoGenerationSupportedDurations({
        provider,
        model: candidate.model,
        inputImageCount,
        inputVideoCount,
      });
      const maxDuration = durCaps?.maxDurationSeconds ?? provider.capabilities.maxDurationSeconds;
      if (
        !supportedDurations &&
        typeof maxDuration === "number" &&
        // Compare the normalized (rounded) duration, not the raw float, since
        // resolveVideoGenerationOverrides applies Math.round before sending to the provider.
        // A request for 4.4s against maxDurationSeconds=4 rounds to 4 and is valid.
        Math.round(requestedDuration) > maxDuration
      ) {
        const error = `${candidate.provider}/${candidate.model} supports at most ${maxDuration}s per video, ${requestedDuration}s requested; skipping`;
        attempts.push({ provider: candidate.provider, model: candidate.model, error });
        lastError = new Error(error);
        warnOnFirstSkip(error);
        log.debug(
          `video-generation candidate skipped (duration capability): ${candidate.provider}/${candidate.model}`,
        );
        continue;
      }
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
        inputImageCount,
        inputVideoCount,
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
        inputAudios: params.inputAudios,
        providerOptions: params.providerOptions,
      });
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      for (const [index, video] of result.videos.entries()) {
        if (!video.buffer && !video.url) {
          throw new Error(
            `Video generation provider returned an undeliverable asset at index ${index}: neither buffer nor url is set.`,
          );
        }
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
