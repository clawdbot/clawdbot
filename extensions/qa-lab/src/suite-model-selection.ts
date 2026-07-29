// QA Lab suite model selection follows an explicitly selected scenario lane.
import {
  isQaFastModeEnabled,
  normalizeQaProviderMode,
  type QaProviderMode,
} from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { defaultQaModelForMode } from "./run-config.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

function normalizeQaSuiteModelRef(input: string | undefined, fallback: string) {
  const model = input?.trim();
  return model && model.length > 0 ? model : fallback;
}

export function resolveRequestedQaSuiteModels(params: {
  alternateModel?: string;
  primaryModel?: string;
  providerMode?: QaProviderMode;
}) {
  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  return {
    providerMode,
    primaryModel: normalizeQaSuiteModelRef(
      params.primaryModel,
      defaultQaModelForMode(providerMode),
    ),
    alternateModel: normalizeQaSuiteModelRef(
      params.alternateModel,
      defaultQaModelForMode(providerMode, true),
    ),
  };
}

export function resolveSelectedQaSuiteModels(params: {
  alternateModelExplicit: boolean;
  fastMode?: boolean;
  primaryModelExplicit: boolean;
  requested: ReturnType<typeof resolveRequestedQaSuiteModels>;
  scenarios: QaSeedScenarioWithSource[];
}) {
  const selectedProviderMode =
    params.scenarios.length === 1 && params.scenarios[0]?.execution.kind === "flow"
      ? params.scenarios[0].execution.providerMode
      : undefined;
  const providerMode = selectedProviderMode ?? params.requested.providerMode;
  const primaryModel =
    selectedProviderMode && !params.primaryModelExplicit
      ? defaultQaModelForMode(providerMode)
      : params.requested.primaryModel;
  const alternateModel =
    selectedProviderMode && !params.alternateModelExplicit
      ? defaultQaModelForMode(providerMode, true)
      : params.requested.alternateModel;
  return {
    alternateModel,
    fastMode: params.fastMode ?? isQaFastModeEnabled({ primaryModel, alternateModel }),
    primaryModel,
    providerMode,
  };
}
