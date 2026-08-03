// Video generation capability helpers derive supported sizes, durations, and modes.
import type {
  VideoGenerationMode,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationTransformCapabilities,
} from "./types.js";

// Video generation mode helpers derive the active mode from reference inputs
// and expose the provider capability block that applies to that mode/model.
export function resolveVideoGenerationMode(params: {
  inputImageCount?: number;
  inputVideoCount?: number;
}): VideoGenerationMode | null {
  const inputImageCount = params.inputImageCount ?? 0;
  const inputVideoCount = params.inputVideoCount ?? 0;
  if (inputImageCount > 0 && inputVideoCount > 0) {
    return null;
  }
  if (inputVideoCount > 0) {
    return "videoToVideo";
  }
  if (inputImageCount > 0) {
    return "imageToVideo";
  }
  return "generate";
}

export function listSupportedVideoGenerationModes(
  provider: Pick<VideoGenerationProvider, "capabilities">,
): VideoGenerationMode[] {
  const modes: VideoGenerationMode[] = ["generate"];
  const imageToVideo = provider.capabilities.imageToVideo;
  if (imageToVideo?.enabled) {
    modes.push("imageToVideo");
  }
  const videoToVideo = provider.capabilities.videoToVideo;
  if (videoToVideo?.enabled) {
    modes.push("videoToVideo");
  }
  return modes;
}

export function resolveVideoGenerationModeCapabilities(params: {
  provider?: Pick<VideoGenerationProvider, "capabilities">;
  model?: string;
  inputImageCount?: number;
  inputVideoCount?: number;
}): {
  mode: VideoGenerationMode | null;
  capabilities: VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined;
} {
  const inputImageCount = params.inputImageCount ?? 0;
  const inputVideoCount = params.inputVideoCount ?? 0;
  const mode = resolveVideoGenerationMode(params);
  const capabilities = params.provider?.capabilities;
  const withModelLimits = <
    T extends VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined,
  >(
    caps: T,
  ): T => {
    // Model-specific caps narrow the provider defaults without mutating the
    // registered provider object shared across requests.
    const model = params.model?.trim();
    if (!caps || !model) {
      return caps;
    }
    const maxInputImages = caps.maxInputImagesByModel?.[model];
    const maxInputVideos = caps.maxInputVideosByModel?.[model];
    const maxInputAudios = caps.maxInputAudiosByModel?.[model];
    if (
      typeof maxInputImages !== "number" &&
      typeof maxInputVideos !== "number" &&
      typeof maxInputAudios !== "number"
    ) {
      return caps;
    }
    return {
      ...caps,
      ...(typeof maxInputImages === "number" ? { maxInputImages } : {}),
      ...(typeof maxInputVideos === "number" ? { maxInputVideos } : {}),
      ...(typeof maxInputAudios === "number" ? { maxInputAudios } : {}),
    };
  };
  if (!capabilities) {
    return { mode, capabilities: undefined };
  }
  if (mode === "generate") {
    return {
      mode,
      capabilities: withModelLimits(capabilities.generate),
    };
  }
  if (mode === "imageToVideo") {
    return {
      mode,
      capabilities: withModelLimits(capabilities.imageToVideo),
    };
  }
  if (mode === "videoToVideo") {
    return {
      mode,
      capabilities: withModelLimits(capabilities.videoToVideo),
    };
  }
  const videoToVideoCapabilities = withModelLimits(capabilities.videoToVideo);
  // Mixed image+video references have no first-class mode label, but providers
  // may support them through video-to-video capabilities that also accept images.
  if (
    inputImageCount > 0 &&
    inputVideoCount > 0 &&
    videoToVideoCapabilities?.enabled &&
    (videoToVideoCapabilities.maxInputImages ?? 0) > 0
  ) {
    return {
      mode,
      capabilities: videoToVideoCapabilities,
    };
  }
  return {
    mode,
    capabilities: undefined,
  };
}
