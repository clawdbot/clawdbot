// Normalizes music generation requests into provider-ready payloads.
import {
  hasMediaNormalizationEntry,
  normalizeDurationToClosestMax,
} from "../media-generation/runtime-shared.js";
import { resolveMusicGenerationModeCapabilities } from "./capabilities.js";
import type {
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "./types.js";

/**
 * Request normalization for music generation.
 *
 * Providers advertise per-mode and per-model support; this module removes
 * unsupported caller overrides and records any duration coercion for metadata.
 */
type ResolvedMusicGenerationOverrides = {
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
  normalization?: MusicGenerationNormalization;
};

function resolveModelBooleanSupport(
  model: string,
  defaultSupport: boolean | undefined,
  supportByModel: Readonly<Record<string, boolean>> | undefined,
): boolean {
  // Per-model declarations override provider defaults because music models vary within a provider.
  return supportByModel?.[model] ?? defaultSupport === true;
}

/** Sanitize caller overrides against provider capabilities before invoking a provider. */
export function resolveMusicGenerationOverrides(params: {
  provider: MusicGenerationProvider;
  model: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
}): ResolvedMusicGenerationOverrides {
  const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
    provider: params.provider,
    inputImageCount: params.inputImages?.length ?? 0,
  });
  const ignoredOverrides: MusicGenerationIgnoredOverride[] = [];
  const normalization: MusicGenerationNormalization = {};
  let lyrics = params.lyrics;
  let instrumental = params.instrumental;
  let durationSeconds = params.durationSeconds;
  let format = params.format;

  if (!caps) {
    return {
      lyrics,
      instrumental,
      durationSeconds,
      format,
      ignoredOverrides,
    };
  }

  if (
    lyrics?.trim() &&
    !resolveModelBooleanSupport(params.model, caps.supportsLyrics, caps.supportsLyricsByModel)
  ) {
    ignoredOverrides.push({ key: "lyrics", value: lyrics });
    lyrics = undefined;
  }

  if (
    typeof instrumental === "boolean" &&
    !resolveModelBooleanSupport(
      params.model,
      caps.supportsInstrumental,
      caps.supportsInstrumentalByModel,
    )
  ) {
    ignoredOverrides.push({ key: "instrumental", value: instrumental });
    instrumental = undefined;
  }

  if (typeof durationSeconds === "number" && !caps.supportsDuration) {
    ignoredOverrides.push({ key: "durationSeconds", value: durationSeconds });
    durationSeconds = undefined;
  } else if (typeof durationSeconds === "number") {
    const normalizedDurationSeconds = normalizeDurationToClosestMax(
      durationSeconds,
      caps.maxDurationSeconds,
    );
    if (
      typeof normalizedDurationSeconds === "number" &&
      normalizedDurationSeconds !== durationSeconds
    ) {
      normalization.durationSeconds = {
        requested: durationSeconds,
        applied: normalizedDurationSeconds,
      };
    }
    durationSeconds = normalizedDurationSeconds;
  }

  if (format) {
    const supportedFormats =
      caps.supportedFormatsByModel?.[params.model] ?? caps.supportedFormats ?? [];
    // An empty supportedFormats list means the provider validates formats internally.
    if (
      !caps.supportsFormat ||
      (supportedFormats.length > 0 && !supportedFormats.includes(format))
    ) {
      ignoredOverrides.push({ key: "format", value: format });
      format = undefined;
    }
  }

  return {
    lyrics,
    instrumental,
    durationSeconds,
    format,
    ignoredOverrides,
    normalization: hasMediaNormalizationEntry(normalization.durationSeconds)
      ? normalization
      : undefined,
  };
}
