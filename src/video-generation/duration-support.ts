import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import type { VideoGenerationProvider } from "./types.js";

function normalizeSupportedDurationValues(
  values: readonly number[] | undefined,
): number[] | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  const normalized = [...new Set(values)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value))
    .filter((value) => value > 0)
    .toSorted((left, right) => left - right);
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveVideoGenerationSupportedDurations(params: {
  provider?: VideoGenerationProvider;
  model?: string;
  inputImageCount?: number;
  inputVideoCount?: number;
}): number[] | undefined {
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const model = params.model?.trim();
  const modelSpecific =
    model && caps?.supportedDurationSecondsByModel
      ? caps.supportedDurationSecondsByModel[model]
      : undefined;
  return normalizeSupportedDurationValues(modelSpecific ?? caps?.supportedDurationSeconds);
}

export function normalizeVideoGenerationDuration(params: {
  provider?: VideoGenerationProvider;
  model?: string;
  durationSeconds?: number;
  inputImageCount?: number;
  inputVideoCount?: number;
}): number | undefined {
  if (typeof params.durationSeconds !== "number" || !Number.isFinite(params.durationSeconds)) {
    return undefined;
  }
  const rounded = Math.max(1, Math.round(params.durationSeconds));
  const supported = resolveVideoGenerationSupportedDurations(params);
  if (!supported || supported.length === 0) {
    return rounded;
  }
  return supported.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}
