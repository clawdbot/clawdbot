import type { MediaNormalizationEntry } from "../../packages/media-generation-core/src/normalization.js";
import {
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
} from "./runtime-shared.js";

type MediaGeometryCapabilities<TResolution extends string> = {
  sizes?: readonly string[];
  aspectRatios?: readonly string[];
  resolutions?: readonly TResolution[];
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
};

type MediaGeometryNormalization<TResolution extends string> = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<TResolution>;
};

type IgnoredMediaGeometryOverride<TResolution extends string> =
  | { key: "size" | "aspectRatio"; value: string }
  | { key: "resolution"; value: TResolution };

/** Normalizes shared image/video geometry while retaining their capability-specific contracts. */
export function resolveMediaGeometryOverrides<TResolution extends string>(params: {
  size?: string;
  aspectRatio?: string;
  resolution?: TResolution;
  capabilities?: MediaGeometryCapabilities<TResolution>;
  fallbackSizes?: readonly string[];
  resolutionOrder?: readonly TResolution[];
  reportUnrecognizedOverrides?: boolean;
  useAspectRatioForRequestedSize?: boolean;
}): {
  size?: string;
  aspectRatio?: string;
  resolution?: TResolution;
  ignoredOverrides: IgnoredMediaGeometryOverride<TResolution>[];
  normalization: MediaGeometryNormalization<TResolution>;
} {
  const caps = params.capabilities;
  const ignoredOverrides: IgnoredMediaGeometryOverride<TResolution>[] = [];
  const normalization: MediaGeometryNormalization<TResolution> = {};
  let { size, aspectRatio, resolution } = params;

  if (!caps) {
    return { size, aspectRatio, resolution, ignoredOverrides, normalization };
  }

  if (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {
    const normalizedSize = resolveClosestSize({
      requestedSize: size,
      requestedAspectRatio: params.useAspectRatioForRequestedSize ? aspectRatio : undefined,
      supportedSizes: caps.sizes,
    });
    if (normalizedSize && normalizedSize !== size) {
      normalization.size = { requested: size, applied: normalizedSize };
    }
    size = normalizedSize;
  }

  if (size && !caps.supportsSize) {
    // A size-only request can still be honored by providers that accept shape.
    const translated = caps.supportsAspectRatio
      ? resolveClosestAspectRatio({
          requestedAspectRatio: aspectRatio,
          requestedSize: size,
          supportedAspectRatios: caps.aspectRatios,
        })
      : undefined;
    if (translated) {
      aspectRatio = translated;
      normalization.aspectRatio = { applied: translated, derivedFrom: "size" };
    } else {
      ignoredOverrides.push({ key: "size", value: size });
    }
    size = undefined;
  }

  if (aspectRatio && (caps.aspectRatios?.length ?? 0) > 0 && caps.supportsAspectRatio) {
    const normalizedAspectRatio = resolveClosestAspectRatio({
      requestedAspectRatio: aspectRatio,
      requestedSize: size,
      supportedAspectRatios: caps.aspectRatios,
    });
    if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) {
      normalization.aspectRatio = { requested: aspectRatio, applied: normalizedAspectRatio };
    } else if (!normalizedAspectRatio && params.reportUnrecognizedOverrides) {
      // Video-only sentinel values must remain visible when another provider rejects them.
      ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    }
    aspectRatio = normalizedAspectRatio;
  } else if (aspectRatio && !caps.supportsAspectRatio) {
    const translated =
      caps.supportsSize && !size
        ? resolveClosestSize({
            requestedSize: params.size,
            requestedAspectRatio: aspectRatio,
            // Empty model lists mean unconstrained image sizes, not no provider-wide hints.
            supportedSizes: caps.sizes?.length === 0 ? params.fallbackSizes : caps.sizes,
          })
        : undefined;
    if (translated) {
      size = translated;
      normalization.size = { applied: translated, derivedFrom: "aspectRatio" };
    } else {
      ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    }
    aspectRatio = undefined;
  }

  if (resolution && (caps.resolutions?.length ?? 0) > 0 && caps.supportsResolution) {
    const normalizedResolution = resolveClosestResolution({
      requestedResolution: resolution,
      supportedResolutions: caps.resolutions,
      order: params.resolutionOrder,
    });
    if (normalizedResolution && normalizedResolution !== resolution) {
      normalization.resolution = { requested: resolution, applied: normalizedResolution };
    } else if (!normalizedResolution && params.reportUnrecognizedOverrides) {
      ignoredOverrides.push({ key: "resolution", value: resolution });
    }
    resolution = normalizedResolution;
  } else if (resolution && !caps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (!normalization.size && size && params.size && params.size !== size) {
    normalization.size = { requested: params.size, applied: size };
  }
  if (
    !normalization.aspectRatio &&
    aspectRatio &&
    ((!params.aspectRatio && params.size) || params.aspectRatio !== aspectRatio)
  ) {
    normalization.aspectRatio = {
      applied: aspectRatio,
      ...(params.aspectRatio ? { requested: params.aspectRatio } : {}),
      ...(!params.aspectRatio && params.size ? { derivedFrom: "size" } : {}),
    };
  }
  if (
    !normalization.resolution &&
    resolution &&
    params.resolution &&
    params.resolution !== resolution
  ) {
    normalization.resolution = { requested: params.resolution, applied: resolution };
  }

  return { size, aspectRatio, resolution, ignoredOverrides, normalization };
}
