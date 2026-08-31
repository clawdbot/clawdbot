// QA Lab suite model selection follows an explicitly selected scenario lane.
import {
  isQaFastModeEnabled,
  normalizeQaProviderMode,
  type QaProviderMode,
} from "./model-selection.js";
import { resolveQaRuntimeModelPair } from "./model-selection.runtime.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import {
  resolveQaScenarioRequiredProviderMode,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";

export function resolveRequestedQaSuiteModels(params: {
  alternateModel?: string;
  fastMode?: boolean;
  primaryModel?: string;
  providerMode?: QaProviderMode;
  scenarioIds?: readonly string[];
  scenarios: readonly QaSeedScenarioWithSource[];
}) {
  // A scenario supplies a single-run default; an explicit provider always owns the selected lane.
  const selectedScenario =
    params.providerMode === undefined && params.scenarioIds?.length === 1
      ? params.scenarios.find((scenario) => scenario.id === params.scenarioIds?.[0])
      : undefined;
  const selectedProviderMode =
    selectedScenario?.execution.kind === "flow"
      ? resolveQaScenarioRequiredProviderMode(selectedScenario)
      : undefined;
  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? selectedProviderMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const { primaryModel, alternateModel } = resolveQaRuntimeModelPair({
    providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
  });
  return {
    alternateModel,
    fastMode: params.fastMode ?? isQaFastModeEnabled({ primaryModel, alternateModel }),
    primaryModel,
    providerMode,
  };
}
