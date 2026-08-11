// Qa Lab plugin module implements model selection behavior.
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import {
  resolveQaLiveFrontierAlternateModel,
  resolveQaLiveFrontierPreferredModel,
} from "./providers/live-frontier/model-selection.runtime.js";

export function defaultQaRuntimeModelForMode(
  mode: QaProviderModeInput,
  options?: {
    alternate?: boolean;
    preferredLiveModel?: string;
  },
) {
  const preferredLiveModel =
    options?.preferredLiveModel ??
    (normalizeQaProviderMode(mode) === DEFAULT_QA_LIVE_PROVIDER_MODE
      ? resolveQaLiveFrontierPreferredModel()
      : undefined);
  return defaultQaModelForMode(mode, {
    ...options,
    preferredLiveModel,
  });
}

export function resolveQaRuntimeModelPair(params: {
  providerMode: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  resolveDefaultModel?: (mode: QaProviderMode, alternate?: boolean) => string;
}) {
  const providerMode = normalizeQaProviderMode(params.providerMode);
  const normalizeModel = (model: string | undefined) => model?.trim() || undefined;
  const resolveDefaultModel =
    params.resolveDefaultModel ??
    ((mode: QaProviderModeInput, alternate = false) =>
      defaultQaRuntimeModelForMode(mode, alternate ? { alternate: true } : undefined));
  const primaryModel = normalizeModel(params.primaryModel) ?? resolveDefaultModel(providerMode);
  const alternateModel =
    normalizeModel(params.alternateModel) ??
    (providerMode === DEFAULT_QA_LIVE_PROVIDER_MODE
      ? (resolveQaLiveFrontierAlternateModel(primaryModel) ??
        resolveDefaultModel(providerMode, true))
      : resolveDefaultModel(providerMode, true));
  return { primaryModel, alternateModel };
}
