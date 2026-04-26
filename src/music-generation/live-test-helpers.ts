import type { OpenClawConfig } from "../config/types.js";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveProviderModels,
  resolveLiveAuthStore,
} from "../media-generation/live-test-helpers.js";

export { parseProviderModelMap, redactLiveApiKey };

export const DEFAULT_LIVE_MUSIC_MODELS: Record<string, string> = {
  google: "google/lyria-3-clip-preview",
  minimax: "minimax/music-2.6",
};

export function parseCsvFilter(raw?: string): Set<string> | null {
  return parseLiveCsvFilter(raw);
}

export function resolveConfiguredLiveMusicModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.musicGenerationModel);
}

export function resolveLiveMusicAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}) {
  return resolveLiveAuthStore(params);
}
