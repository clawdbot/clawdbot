// Runs music generation requests through provider runtimes and fallbacks.
import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseMusicGenerationModelRef } from "../media-generation/model-ref.js";
import {
  getMusicGenerationProvider,
  listMusicGenerationProviders,
} from "../media-generation/registry.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { withPluginRegistryResourceOperationAsync } from "../plugins/registry-resources.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { resolveMusicGenerationOverrides } from "./normalization.js";
import type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
import type { MusicGenerationResult } from "./types.js";

/**
 * Music generation runtime orchestration.
 *
 * The runtime resolves provider/model candidates, applies capability-based
 * normalization, invokes providers, and records fallback attempts consistently
 * with other media generation capabilities.
 */
const log = createSubsystemLogger("music-generation");

/** Injectable dependencies used by tests and alternate runtime hosts. */
type MusicGenerationRuntimeDeps = {
  getProvider?: typeof getMusicGenerationProvider;
  listProviders?: typeof listMusicGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVars;
  log?: Pick<typeof log, "debug">;
};

/** List runtime-visible music generation providers for a config snapshot. */
export function listRuntimeMusicGenerationProviders(
  params?: { config?: OpenClawConfig },
  deps: MusicGenerationRuntimeDeps = {},
) {
  return (deps.listProviders ?? listMusicGenerationProviders)(params?.config);
}

/** Generate music with provider fallback and capability-aware request normalization. */
export async function generateMusic(
  params: GenerateMusicParams,
  deps: MusicGenerationRuntimeDeps = {},
): Promise<GenerateMusicRuntimeResult> {
  return withPluginRegistryResourceOperationAsync(() => generateMusicWithResources(params, deps));
}

async function generateMusicWithResources(
  params: GenerateMusicParams,
  deps: MusicGenerationRuntimeDeps,
): Promise<GenerateMusicRuntimeResult> {
  const getProvider = deps.getProvider ?? getMusicGenerationProvider;
  const listProviders = deps.listProviders ?? listMusicGenerationProviders;
  const logger = deps.log ?? log;
  const timeoutMs =
    params.timeoutMs ??
    resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.mediaModels?.music);
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.mediaModels?.music,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
    agentDir: params.agentDir,
    listProviders,
    autoProviderFallback: params.autoProviderFallback,
  });
  if (candidates.length === 0) {
    throw new Error(
      buildNoCapabilityModelConfiguredMessage({
        capabilityLabel: "music-generation",
        modelConfigKey: "mediaModels.music",
        providers: listProviders(params.cfg),
        fallbackSampleRef: "google/lyria-3-clip-preview",
        getProviderEnvVars: deps.getProviderEnvVars,
      }),
    );
  }

  return runMediaGenerationCandidates({
    candidates,
    capability: "music",
    getProvider: (providerId) => getProvider(providerId, params.cfg),
    includeSkipFailureDetails: true,
    onFailure: (attempt) => {
      logger.debug(`music-generation candidate failed: ${attempt.provider}/${attempt.model}`);
    },
    prepareCandidate(candidate, provider) {
      const referenceImageError = resolveReferenceImageCapabilityError({
        candidateRef: `${candidate.provider}/${candidate.model}`,
        inputImageCount: params.inputImages?.length ?? 0,
        edit: provider.capabilities.edit,
      });
      if (referenceImageError) {
        logger.debug(`music-generation candidate skipped: ${referenceImageError}`);
        return referenceImageError;
      }

      return async (attempts): Promise<GenerateMusicRuntimeResult> => {
        const sanitized = resolveMusicGenerationOverrides({
          provider,
          model: candidate.model,
          lyrics: params.lyrics,
          instrumental: params.instrumental,
          durationSeconds: params.durationSeconds,
          format: params.format,
          inputImages: params.inputImages,
        });
        const result: MusicGenerationResult = await provider.generateMusic({
          provider: candidate.provider,
          model: candidate.model,
          prompt: params.prompt,
          cfg: params.cfg,
          agentDir: params.agentDir,
          authStore: params.authStore,
          lyrics: sanitized.lyrics,
          instrumental: sanitized.instrumental,
          durationSeconds: sanitized.durationSeconds,
          format: sanitized.format,
          inputImages: params.inputImages,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (!Array.isArray(result.tracks) || result.tracks.length === 0) {
          throw new Error("Music generation provider returned no tracks.");
        }
        const emptyTrackIndex = result.tracks.findIndex((track) => track.buffer.byteLength === 0);
        if (emptyTrackIndex >= 0) {
          throw new Error(
            `Music generation provider returned an empty track buffer at index ${emptyTrackIndex}.`,
          );
        }
        return {
          tracks: result.tracks,
          provider: candidate.provider,
          model: result.model ?? candidate.model,
          attempts,
          lyrics: result.lyrics,
          normalization: sanitized.normalization,
          metadata: {
            ...result.metadata,
            ...buildMediaGenerationNormalizationMetadata({
              normalization: sanitized.normalization,
            }),
          },
          ignoredOverrides: sanitized.ignoredOverrides,
        };
      };
    },
  });
}
