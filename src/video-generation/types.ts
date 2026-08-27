// Video generation types reuse the SDK contracts and add runtime normalization metadata.
import type { MediaNormalizationEntry } from "../../packages/media-generation-core/src/normalization.js";
import type { VideoGenerationResolution } from "../plugin-sdk/video-generation.js";

export type {
  GeneratedVideoAsset,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
  VideoGenerationRequest,
  VideoGenerationResult,
  VideoGenerationMode,
  VideoGenerationProviderOptionType,
  VideoGenerationModeCapabilities,
  VideoGenerationTransformCapabilities,
  VideoGenerationProviderCapabilities,
  VideoGenerationCatalogModelEntry,
  VideoGenerationProvider,
} from "../plugin-sdk/video-generation.js";

export type VideoGenerationIgnoredOverride = {
  key: "size" | "aspectRatio" | "resolution" | "audio" | "watermark";
  value: string | boolean;
};

export type VideoGenerationNormalization = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<VideoGenerationResolution>;
  durationSeconds?: MediaNormalizationEntry<number>;
};
