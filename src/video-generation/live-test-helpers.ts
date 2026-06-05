// Video live test helpers resolve live provider test settings from environment.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveProviderModels,
  resolveLiveAuthStore,
} from "../media-generation/live-test-helpers.js";

export { parseProviderModelMap, redactLiveApiKey };

// Default provider/model matrix for video live tests. Env/config filters can
// override this without editing the live test source.
export const DEFAULT_LIVE_VIDEO_MODELS: Record<string, string> = {
  alibaba: "alibaba/wan2.6-t2v",
  byteplus: "byteplus/seedance-1-0-lite-t2v-250428",
  deepinfra: "deepinfra/Pixverse/Pixverse-T2V",
  fal: "fal/fal-ai/minimax/video-01-live",
  google: "google/veo-3.1-fast-generate-preview",
  minimax: "minimax/MiniMax-Hailuo-2.3",
  openai: "openai/sora-2",
  openrouter: "openrouter/google/veo-3.1-fast",
  pixverse: "pixverse/v6",
  qwen: "qwen/wan2.6-t2v",
  runway: "runway/gen4.5",
  together: "together/Wan-AI/Wan2.2-T2V-A14B",
  vydra: "vydra/veo3",
  xai: "xai/grok-imagine-video",
};

const REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS = new Set(["alibaba", "google", "openai", "qwen", "xai"]);
const BUFFER_BACKED_IMAGE_TO_VIDEO_UNSUPPORTED_PROVIDERS = new Set(["vydra"]);
const TOGETHER_BUFFER_BACKED_IMAGE_TO_VIDEO_MODEL = "Wan-AI/Wan2.2-I2V-A14B";

// Keep live-test resolution conservative and provider-specific so broad smoke
// lanes do not spend extra time or hit unsupported defaults.
export function resolveLiveVideoResolution(params: {
  providerId: string;
  modelRef: string;
}): "480P" | "540P" | "720P" | "768P" | "1080P" {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  if (providerId === "minimax") {
    return "768P";
  }
  if (providerId === "openrouter") {
    return "720P";
  }
  if (providerId === "pixverse") {
    return "540P";
  }
  return "480P";
}

export function parseCsvFilter(raw?: string): Set<string> | null {
  return parseLiveCsvFilter(raw);
}

export function resolveConfiguredLiveVideoModels(cfg: OpenClawConfig): Map<string, string> {
  return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.videoGenerationModel);
}

export function canRunBufferBackedVideoToVideoLiveLane(params: {
  providerId: string;
  modelRef: string;
}): boolean {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  // Some providers only accept remote URL references in live video-to-video
  // lanes; skip buffer-backed coverage for those providers.
  if (REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS.has(providerId)) {
    return false;
  }
  if (providerId !== "runway") {
    if (providerId === "fal") {
      return params.modelRef.includes("reference-to-video");
    }
    return true;
  }
  const slash = params.modelRef.indexOf("/");
  const model =
    slash <= 0 || slash === params.modelRef.length - 1
      ? params.modelRef.trim()
      : params.modelRef.slice(slash + 1).trim();
  return model === "gen4_aleph";
}

export function canRunBufferBackedImageToVideoLiveLane(params: {
  providerId: string;
  modelRef: string;
}): boolean {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  if (BUFFER_BACKED_IMAGE_TO_VIDEO_UNSUPPORTED_PROVIDERS.has(providerId)) {
    return false;
  }
  if (providerId === "together") {
    return params.modelRef.includes(TOGETHER_BUFFER_BACKED_IMAGE_TO_VIDEO_MODEL);
  }
  return true;
}

export function resolveLiveVideoAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}) {
  return resolveLiveAuthStore(params);
}
