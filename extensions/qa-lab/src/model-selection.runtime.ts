import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { resolveQaLiveFrontierPreferredModel } from "./providers/live-frontier/model-selection.runtime.js";

export function resolveQaPreferredLiveModel() {
  return resolveQaLiveFrontierPreferredModel();
}

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
      ? resolveQaPreferredLiveModel()
      : undefined);
  return defaultQaModelForMode(mode, {
    ...options,
    preferredLiveModel,
  });
}
