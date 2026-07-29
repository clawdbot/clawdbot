import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../model-selection.js";
import {
  resolveQaProfileScenarios,
  resolveQaRunProfileExecutionSelection,
  scenarioDeclaresQaChannel,
} from "../../profile-planning.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";

export function resolveLiveTransportQaScenarioIds(params: {
  channelId: string;
  profile?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  return resolveQaProfileScenarios({
    profile: params.profile?.trim() || "release",
    providerMode: params.providerMode,
    channelDriver: "live",
    channel: params.channelId,
    requireDeclaredChannel: true,
    scenarioIds: params.scenarioIds,
  }).scenarios.map((scenario) => scenario.id);
}

export function listLiveTransportQaScenarios(params: {
  channelId: string;
  providerMode: QaProviderModeInput;
}) {
  const defaultIds = new Set(resolveLiveTransportQaScenarioIds(params));
  const providerMode = normalizeQaProviderMode(params.providerMode);
  const eligibleScenarios = readQaScenarioPack().scenarios.filter((scenario) =>
    scenarioDeclaresQaChannel(scenario, params.channelId),
  );
  const scenarios = resolveQaRunProfileExecutionSelection({
    scenarios: eligibleScenarios,
    providerMode,
    primaryModel: defaultQaModelForMode(providerMode),
    channelDriver: "live",
    channel: params.channelId,
  }).selectedScenarios;
  return scenarios.map((scenario) => {
    return {
      id: scenario.id,
      title: scenario.title,
      rationale: scenario.objective,
      regressionRefs: scenario.regressionRefs ?? [],
      defaultEnabled: defaultIds.has(scenario.id),
    };
  });
}
