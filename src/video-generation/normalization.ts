// Video generation normalization helpers map user inputs to provider requests.
import { resolveMediaGeometryOverrides } from "../media-generation/geometry-normalization.js";
import { hasMediaNormalizationEntry } from "../media-generation/runtime-shared.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import {
  normalizeVideoGenerationDuration,
  resolveVideoGenerationSupportedDurations,
} from "./duration-support.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationProvider,
  VideoGenerationResolution,
} from "./types.js";

const VIDEO_RESOLUTION_ORDER: readonly VideoGenerationResolution[] = [
  "360P",
  "480P",
  "540P",
  "720P",
  "768P",
  "1080P",
];

type ResolvedVideoGenerationOverrides = {
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  audio?: boolean;
  watermark?: boolean;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
  normalization?: VideoGenerationNormalization;
};

export function resolveVideoGenerationOverrides(params: {
  provider: VideoGenerationProvider;
  model: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImageCount?: number;
  inputVideoCount?: number;
}): ResolvedVideoGenerationOverrides {
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const sanitized = resolveMediaGeometryOverrides({
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    capabilities: caps,
    resolutionOrder: VIDEO_RESOLUTION_ORDER,
    reportUnrecognizedOverrides: true,
    useAspectRatioForRequestedSize: true,
  });
  const ignoredOverrides: VideoGenerationIgnoredOverride[] = sanitized.ignoredOverrides;
  const normalization: VideoGenerationNormalization = sanitized.normalization;
  let { audio, watermark } = params;

  if (caps && typeof audio === "boolean" && !caps.supportsAudio) {
    ignoredOverrides.push({ key: "audio", value: audio });
    audio = undefined;
  }
  if (caps && typeof watermark === "boolean" && !caps.supportsWatermark) {
    ignoredOverrides.push({ key: "watermark", value: watermark });
    watermark = undefined;
  }

  const requestedDurationSeconds =
    typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds)
      ? Math.max(1, Math.round(params.durationSeconds))
      : undefined;
  const durationSeconds = normalizeVideoGenerationDuration({
    provider: params.provider,
    model: params.model,
    durationSeconds: requestedDurationSeconds,
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
  });
  const supportedDurationSeconds = resolveVideoGenerationSupportedDurations({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
  });

  if (
    typeof requestedDurationSeconds === "number" &&
    typeof durationSeconds === "number" &&
    requestedDurationSeconds !== durationSeconds
  ) {
    normalization.durationSeconds = {
      requested: requestedDurationSeconds,
      applied: durationSeconds,
      ...(supportedDurationSeconds?.length ? { supportedValues: supportedDurationSeconds } : {}),
    };
  }

  return {
    size: sanitized.size,
    aspectRatio: sanitized.aspectRatio,
    resolution: sanitized.resolution,
    durationSeconds,
    supportedDurationSeconds,
    audio,
    watermark,
    ignoredOverrides,
    normalization:
      hasMediaNormalizationEntry(normalization.size) ||
      hasMediaNormalizationEntry(normalization.aspectRatio) ||
      hasMediaNormalizationEntry(normalization.resolution) ||
      hasMediaNormalizationEntry(normalization.durationSeconds)
        ? normalization
        : undefined,
  };
}
