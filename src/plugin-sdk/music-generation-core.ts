// Shared music-generation implementation helpers for bundled and third-party plugins.

export type { AuthProfileStore } from "../agents/auth-profiles/types.js";
export type { FallbackAttempt } from "../agents/model-fallback.types.js";
export type { OpenClawConfig } from "../config/types.openclaw.js";
export type { MusicGenerationProviderPlugin } from "../plugins/types.js";
export type {
  GeneratedMusicAsset,
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationProviderCapabilities,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicGenerationSourceImage,
} from "../music-generation/types.js";

export { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
export {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { parseMusicGenerationModelRef } from "../music-generation/model-ref.js";
export {
  getMusicGenerationProvider,
  listMusicGenerationProviders,
} from "../music-generation/provider-registry.js";
export { getProviderEnvVars } from "../secrets/provider-env-vars.js";
