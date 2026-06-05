// Deepinfra plugin module implements surface model catalogs behavior.
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  VideoGenerationModelCapabilitiesContext,
  VideoGenerationProviderCapabilities,
} from "openclaw/plugin-sdk/video-generation";
import { DEEPINFRA_VIDEO_ASPECT_RATIOS, DEEPINFRA_VIDEO_DURATIONS } from "./media-models.js";
import { discoverDeepInfraSurfaces, type DeepInfraSurfaceModel } from "./provider-models.js";

const PROVIDER_ID = "deepinfra";

// Live catalog providers (registered via api.registerModelCatalogProvider).
// Mirrors extensions/openrouter/video-model-catalog.ts: auth-gated (returns
// null without a key so the static fallback wins), and reuses the cached
// discoverDeepInfraSurfaces call so chat/image-gen/video-gen share one fetch.

function surfaceModelToImageGenEntry(model: DeepInfraSurfaceModel): UnifiedModelCatalogEntry {
  return {
    kind: "image_generation",
    provider: PROVIDER_ID,
    model: model.id,
    source: "live",
    ...(model.name ? { label: model.name } : {}),
  };
}

function surfaceModelToVideoGenEntry(
  model: DeepInfraSurfaceModel,
): UnifiedModelCatalogEntry<VideoGenerationProviderCapabilities> {
  return {
    kind: "video_generation",
    provider: PROVIDER_ID,
    model: model.id,
    source: "live",
    ...(model.name ? { label: model.name } : {}),
    capabilities: buildDeepInfraVideoModelCapabilities(),
  };
}

// Canonical DeepInfra-wide video-gen shape. Wire per-model hints
// (metadata.supported_durations etc.) in here once the backend emits them.
function buildDeepInfraVideoModelCapabilities(): VideoGenerationProviderCapabilities {
  return {
    providerOptions: {
      seed: "number",
      negative_prompt: "string",
      negativePrompt: "string",
      style: "string",
      guidance_scale: "number",
      guidanceScale: "number",
    },
    generate: {
      maxVideos: 1,
      maxDurationSeconds: 8,
      supportedDurationSeconds: [...DEEPINFRA_VIDEO_DURATIONS],
      supportsAspectRatio: true,
      aspectRatios: [...DEEPINFRA_VIDEO_ASPECT_RATIOS],
    },
    imageToVideo: { enabled: false },
    videoToVideo: { enabled: false },
  };
}

export async function listDeepInfraImageGenCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<readonly UnifiedModelCatalogEntry[] | null> {
  const { discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  if (!discoveryApiKey) {
    return null;
  }
  const catalog = await discoverDeepInfraSurfaces({ hasApiKey: true, env: ctx.env });
  // Bail on non-live (static fallback owns offline) and on empty surface
  // (returning [] would starve the unified catalog instead of falling back).
  if (!catalog.live || catalog.imageGen.length === 0) {
    return null;
  }
  return catalog.imageGen.map(surfaceModelToImageGenEntry);
}

export async function listDeepInfraVideoGenCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<readonly UnifiedModelCatalogEntry<VideoGenerationProviderCapabilities>[] | null> {
  const { discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  if (!discoveryApiKey) {
    return null;
  }
  const catalog = await discoverDeepInfraSurfaces({ hasApiKey: true, env: ctx.env });
  if (!catalog.live || catalog.videoGen.length === 0) {
    return null;
  }
  return catalog.videoGen.map(surfaceModelToVideoGenEntry);
}

// VideoGenerationProvider.resolveModelCapabilities hook. Returns the
// capability shape per-request when the model is live; provider static caps
// are the fallback.
export async function resolveDeepInfraVideoModelCapabilities(
  ctx: VideoGenerationModelCapabilitiesContext,
): Promise<VideoGenerationProviderCapabilities | undefined> {
  // Model id may arrive bare or `deepinfra/`-prefixed.
  const rawId = typeof ctx.model === "string" ? ctx.model : "";
  const normalized = rawId.startsWith(`${PROVIDER_ID}/`)
    ? rawId.slice(PROVIDER_ID.length + 1)
    : rawId;
  const catalog = await discoverDeepInfraSurfaces({
    env: process.env,
  });
  const entry =
    catalog.videoGen.find((m) => m.id === normalized) ??
    catalog.videoGen.find((m) => m.id === rawId);
  return entry ? buildDeepInfraVideoModelCapabilities() : undefined;
}
