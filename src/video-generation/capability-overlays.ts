import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import type { GenerateVideoParams } from "./runtime-types.js";
import type {
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationTransformCapabilities,
} from "./types.js";

function isVideoGenerationTransformCapabilities(
  capabilities: VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined,
): capabilities is VideoGenerationTransformCapabilities {
  return Boolean(capabilities && "enabled" in capabilities);
}

export function buildReferenceInputCapabilityFailure(params: {
  providerId: string;
  model: string;
  provider: VideoGenerationProvider;
  inputImageCount: number;
  inputVideoCount: number;
  inputAudioCount: number;
}): string | undefined {
  const { providerId, model, provider, inputImageCount, inputVideoCount, inputAudioCount } = params;
  const label = `${providerId}/${model}`;
  const { capabilities } = resolveVideoGenerationModeCapabilities({
    provider,
    model,
    inputImageCount,
    inputVideoCount,
  });

  if (inputImageCount > 0 || inputVideoCount > 0) {
    const visualLabel =
      inputImageCount > 0 && inputVideoCount > 0
        ? "combined image/video reference inputs"
        : inputImageCount > 0
          ? "reference image inputs"
          : "reference video inputs";
    if (!capabilities || !isVideoGenerationTransformCapabilities(capabilities)) {
      return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
    }
    if (!capabilities.enabled) {
      return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
    }
  }

  if (inputImageCount > 0) {
    const maxImages = capabilities?.maxInputImages ?? provider.capabilities.maxInputImages ?? 0;
    if (inputImageCount > maxImages) {
      return maxImages === 0
        ? `${label} does not support reference image inputs; skipping to avoid silent image drop`
        : `${label} supports at most ${maxImages} reference image(s), ${inputImageCount} requested; skipping`;
    }
  }

  if (inputVideoCount > 0) {
    const maxVideos = capabilities?.maxInputVideos ?? provider.capabilities.maxInputVideos ?? 0;
    if (inputVideoCount > maxVideos) {
      return maxVideos === 0
        ? `${label} does not support reference video inputs; skipping to avoid silent video drop`
        : `${label} supports at most ${maxVideos} reference video(s), ${inputVideoCount} requested; skipping`;
    }
  }

  if (inputAudioCount > 0) {
    const maxAudio = capabilities?.maxInputAudios ?? provider.capabilities.maxInputAudios ?? 0;
    if (inputAudioCount > maxAudio) {
      return maxAudio === 0
        ? `${label} does not support reference audio inputs; skipping to avoid silent audio drop`
        : `${label} supports at most ${maxAudio} reference audio(s), ${inputAudioCount} requested; skipping`;
    }
  }

  return undefined;
}

function mergeVideoGenerationModeCapabilities<
  T extends VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined,
>(base: T, overlay: T): T {
  if (!overlay) {
    return base;
  }
  if (!base) {
    return overlay;
  }
  const overlayOptions = overlay.providerOptions;
  const hasOverlayOptions = Object.hasOwn(overlay, "providerOptions");
  const mergedProviderOptions =
    hasOverlayOptions && overlayOptions && Object.keys(overlayOptions).length === 0
      ? overlayOptions
      : base.providerOptions || overlayOptions
        ? {
            ...base.providerOptions,
            ...overlayOptions,
          }
        : undefined;

  return {
    ...base,
    ...overlay,
    ...(mergedProviderOptions ? { providerOptions: mergedProviderOptions } : {}),
  } as T;
}

export function mergeVideoGenerationProviderCapabilities(
  base: VideoGenerationProviderCapabilities,
  overlay: VideoGenerationProviderCapabilities,
): VideoGenerationProviderCapabilities {
  const overlayOptions = overlay.providerOptions;
  const hasOverlayOptions = Object.hasOwn(overlay, "providerOptions");
  const mergedProviderOptions =
    hasOverlayOptions && overlayOptions && Object.keys(overlayOptions).length === 0
      ? overlayOptions
      : base.providerOptions || overlayOptions
        ? {
            ...base.providerOptions,
            ...overlayOptions,
          }
        : undefined;

  return {
    ...base,
    ...overlay,
    ...(mergedProviderOptions ? { providerOptions: mergedProviderOptions } : {}),
    generate: mergeVideoGenerationModeCapabilities(base.generate, overlay.generate),
    imageToVideo: mergeVideoGenerationModeCapabilities(base.imageToVideo, overlay.imageToVideo),
    videoToVideo: mergeVideoGenerationModeCapabilities(base.videoToVideo, overlay.videoToVideo),
  };
}

export async function resolveProviderWithModelCapabilities(params: {
  provider: VideoGenerationProvider;
  providerId: string;
  model: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: GenerateVideoParams["authStore"];
  timeoutMs?: number;
  log: Pick<Console, "debug">;
}): Promise<VideoGenerationProvider> {
  if (!params.provider.resolveModelCapabilities) {
    return params.provider;
  }
  try {
    const modelCapabilities = await params.provider.resolveModelCapabilities({
      provider: params.providerId,
      model: params.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore: params.authStore,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    if (!modelCapabilities) {
      return params.provider;
    }
    return {
      ...params.provider,
      capabilities: mergeVideoGenerationProviderCapabilities(
        params.provider.capabilities,
        modelCapabilities,
      ),
    };
  } catch (err) {
    params.log.debug(
      `video-generation model capability lookup failed for ${params.providerId}/${params.model}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return params.provider;
  }
}
