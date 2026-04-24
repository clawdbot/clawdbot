import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveProviderModels,
  resolveLiveAuthStore,
} from "../media-generation/live-test-helpers.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export { parseProviderModelMap, redactLiveApiKey };

export const DEFAULT_LIVE_IMAGE_MODELS: Record<string, string> = {
  fal: "fal/fal-ai/flux/dev",
  google: "google/gemini-3.1-flash-image-preview",
  minimax: "minimax/image-01",
  openai: "openai/gpt-image-2",
  openrouter: "openrouter/google/gemini-3.1-flash-image-preview",
  vydra: "vydra/grok-imagine",
  xai: "xai/grok-imagine-image",
};

export function parseCaseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") {
    return null;
  }
  const values = trimmed
    .split(",")
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? new Set(values) : null;
}

export function parseCsvFilter(raw?: string): Set<string> | null {
  return parseLiveCsvFilter(raw, { lowercase: false });
}

export function resolveConfiguredLiveImageModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.imageGenerationModel);
}

export function resolveLiveImageAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}) {
  return resolveLiveAuthStore(params);
}
