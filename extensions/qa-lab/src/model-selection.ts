import {
  DEFAULT_QA_LIVE_PROVIDER_MODE,
  getQaProvider,
  type QaProviderMode,
  type QaProviderModeInput,
} from "./providers/index.js";

export type { QaProviderMode, QaProviderModeInput } from "./providers/index.js";

export type QaModelSelection = {
  primaryModel: string;
  alternateModel: string;
};

export { normalizeQaProviderMode } from "./providers/index.js";

export function defaultQaModelForMode(
  mode: QaProviderModeInput,
  options?: {
    alternate?: boolean;
    preferredLiveModel?: string;
  },
) {
  return getQaProvider(mode).defaultModel(options);
}

export function splitQaModelRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
  };
}

export function isQaFastModeModelRef(ref: string) {
  return getQaProvider(DEFAULT_QA_LIVE_PROVIDER_MODE).usesFastModeByDefault(ref);
}

export function isQaFastModeEnabled(selection: QaModelSelection) {
  return (
    isQaFastModeModelRef(selection.primaryModel) || isQaFastModeModelRef(selection.alternateModel)
  );
}
