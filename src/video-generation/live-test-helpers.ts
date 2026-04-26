import type { OpenClawConfig } from "../config/types.js";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveProviderModels,
  resolveLiveAuthStore,
} from "../media-generation/live-test-helpers.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export { parseProviderModelMap, redactLiveApiKey };

export const DEFAULT_LIVE_VIDEO_MODELS: Record<string, string> = {
  alibaba: "alibaba/wan2.6-t2v",
  byteplus: "byteplus/seedance-1-0-lite-t2v-250428",
  fal: "fal/fal-ai/minimax/video-01-live",
  google: "google/veo-3.1-fast-generate-preview",
  minimax: "minimax/MiniMax-Hailuo-2.3",
  openai: "openai/sora-2",
  qwen: "qwen/wan2.6-t2v",
  runway: "runway/gen4.5",
  together: "together/Wan-AI/Wan2.2-T2V-A14B",
  vydra: "vydra/veo3",
  xai: "xai/grok-imagine-video",
};

const REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS = new Set(["alibaba", "google", "openai", "qwen", "xai"]);
const BUFFER_BACKED_IMAGE_TO_VIDEO_UNSUPPORTED_PROVIDERS = new Set(["vydra"]);

export function resolveLiveVideoResolution(params: {
  providerId: string;
  modelRef: string;
}): "480P" | "768P" | "1080P" {
  const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
  if (providerId === "minimax") {
    return "768P";
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
  return true;
}

export function resolveLiveVideoAuthStore(params: {
  requireProfileKeys: boolean;
  hasLiveKeys: boolean;
}) {
  return resolveLiveAuthStore(params);
}
