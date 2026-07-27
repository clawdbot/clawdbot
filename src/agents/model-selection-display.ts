/**
 * Formats selected model references for UI/session display.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Inputs used to choose the visible model ref/name for status surfaces. */
type ModelDisplaySelectionParams = {
  runtimeProvider?: unknown;
  runtimeModel?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
  fallbackModel?: unknown;
};

/** Resolves the most specific provider/model ref for display. */
export function resolveModelDisplayRef(params: ModelDisplaySelectionParams): string | undefined {
  const runtimeModel = normalizeOptionalString(params.runtimeModel);
  const runtimeProvider = normalizeOptionalString(params.runtimeProvider);
  if (runtimeModel) {
    if (runtimeModel.includes("/")) {
      return runtimeModel;
    }
    if (runtimeProvider) {
      return `${runtimeProvider}/${runtimeModel}`;
    }
    return runtimeModel;
  }
  if (runtimeProvider) {
    return runtimeProvider;
  }

  const overrideModel = normalizeOptionalString(params.overrideModel);
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  if (overrideModel) {
    if (overrideModel.includes("/")) {
      return overrideModel;
    }
    if (overrideProvider) {
      return `${overrideProvider}/${overrideModel}`;
    }
    return overrideModel;
  }
  if (overrideProvider) {
    return overrideProvider;
  }

  const fallbackModel = normalizeOptionalString(params.fallbackModel);
  return fallbackModel || undefined;
}

/** Resolves the model name shown in compact status output. */
export function resolveModelDisplayName(params: ModelDisplaySelectionParams): string {
  const modelRef = resolveModelDisplayRef(params);
  if (!modelRef) {
    return "model n/a";
  }
  const slash = modelRef.lastIndexOf("/");
  if (slash >= 0 && slash < modelRef.length - 1) {
    return modelRef.slice(slash + 1);
  }
  return modelRef;
}

/** Inputs used to resolve model/provider values for session info. */
type SessionInfoModelSelectionParams = {
  currentProvider?: unknown;
  currentModel?: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  entryProvider?: unknown;
  entryModel?: unknown;
  overrideProvider?: unknown;
  overrideModel?: unknown;
};

/** Resolves session-info model selection from entry, override, and fallback data. */
export function resolveSessionInfoModelSelection(params: SessionInfoModelSelectionParams): {
  modelProvider?: string;
  model?: string;
} {
  const fallbackProvider =
    normalizeOptionalString(params.currentProvider) ??
    normalizeOptionalString(params.defaultProvider) ??
    undefined;
  const fallbackModel =
    normalizeOptionalString(params.currentModel) ??
    normalizeOptionalString(params.defaultModel) ??
    undefined;

  if (params.entryProvider !== undefined || params.entryModel !== undefined) {
    return {
      modelProvider: normalizeOptionalString(params.entryProvider) ?? fallbackProvider,
      model: normalizeOptionalString(params.entryModel) ?? fallbackModel,
    };
  }

  const overrideModel = normalizeOptionalString(params.overrideModel);
  if (overrideModel) {
    const overrideProvider = normalizeOptionalString(params.overrideProvider);
    return {
      modelProvider: overrideProvider || fallbackProvider,
      model: overrideModel,
    };
  }

  return {
    modelProvider: fallbackProvider,
    model: fallbackModel,
  };
}
