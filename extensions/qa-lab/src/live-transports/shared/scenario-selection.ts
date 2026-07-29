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
import type { QaScorecardChannelDriver } from "../../scorecard-taxonomy.js";
import { selectQaFlowSuiteScenarios } from "../../suite-planning.js";

export function resolveCatalogLiveTransportQaScenarioIds(params: {
  channelId: string;
  channelDriver?: QaScorecardChannelDriver;
  primaryModel?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  const channelId = params.channelId.trim().toLowerCase();
  const catalog = readQaScenarioPack().scenarios;
  const scenarios = params.scenarioIds?.length
    ? catalog
    : catalog.filter((scenario) => scenarioDeclaresQaChannel(scenario, channelId));
  const providerMode = normalizeQaProviderMode(params.providerMode);
  const selectedScenarios = selectQaFlowSuiteScenarios({
    scenarios,
    scenarioIds: params.scenarioIds?.length ? [...params.scenarioIds] : undefined,
    providerMode,
    primaryModel: params.primaryModel?.trim() || defaultQaModelForMode(providerMode),
    channelDriver: params.channelDriver ?? "live",
    channel: channelId,
  });
  if (selectedScenarios.length === 0) {
    throw new Error(`${channelId} QA catalog selection resolved no scenarios.`);
  }
  return selectedScenarios.map((scenario) => scenario.id);
}

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
