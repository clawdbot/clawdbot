// Live-test helpers for music generation provider configuration.
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveConfiguredLiveProviderModels,
  resolveLiveAuthStore,
} from "../media-generation/live-test-helpers.js";

/**
 * Live-test helpers for music generation providers.
 *
 * This module adapts the shared media live-test parsing/auth helpers to the
 * music-generation config key and default provider model list.
 */

/** Default live model refs used when a provider is enabled but not explicitly mapped. */
export const DEFAULT_LIVE_MUSIC_MODELS: Record<string, string> = {
  fal: "fal/fal-ai/minimax-music/v2.6",
  google: "google/lyria-3-clip-preview",
  minimax: "minimax/music-2.6",
  openrouter: "openrouter/google/lyria-3-pro-preview",
};

/** Resolve configured provider/model refs from the musicGenerationModel defaults. */
export function resolveConfiguredLiveMusicModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.mediaModels?.music);
}

/** Resolve whether live music tests should require auth profile keys. */
export function resolveLiveMusicAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}) {
  return resolveLiveAuthStore(params);
}
