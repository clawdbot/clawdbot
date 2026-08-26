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
  supportsModuleFlows?: boolean;
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
    resolveModuleFlowSupport: () => params.supportsModuleFlows === true,
  });
  if (selectedScenarios.length === 0) {
    throw new Error(`${channelId} QA catalog selection resolved no scenarios.`);
  }
  return selectedScenarios.map((scenario) => scenario.id);
}

export function resolveTransportQaScenarioIds(params: {
  channelId: string;
  channelDriver: QaScorecardChannelDriver;
  profile?: string;
  primaryModel?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
  supportsModuleFlows?: boolean;
}) {
  if (!params.profile?.trim() && params.channelDriver === "crabline") {
    return resolveCatalogLiveTransportQaScenarioIds({
      channelId: params.channelId,
      channelDriver: params.channelDriver,
      primaryModel: params.primaryModel,
      providerMode: params.providerMode,
      scenarioIds: params.scenarioIds,
    });
  }
  return resolveQaProfileScenarios({
    profile: params.profile?.trim() || "release",
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    channelDriver: params.channelDriver,
    channel: params.channelId,
    executionKind: "flow",
    requireDeclaredChannel: true,
    resolveModuleFlowSupport: () => params.supportsModuleFlows === true,
    scenarioIds: params.scenarioIds,
  }).scenarios.map((scenario) => scenario.id);
}

export function resolveLiveTransportQaScenarioIds(
  params: Omit<Parameters<typeof resolveTransportQaScenarioIds>[0], "channelDriver">,
) {
  return resolveTransportQaScenarioIds({ ...params, channelDriver: "live" });
}

export function listLiveTransportQaScenarios(params: {
  channelId: string;
  primaryModel?: string;
  providerMode: QaProviderModeInput;
  supportsModuleFlows?: boolean;
}) {
  const defaultIds = new Set(resolveLiveTransportQaScenarioIds(params));
  const providerMode = normalizeQaProviderMode(params.providerMode);
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const eligibleScenarios = readQaScenarioPack().scenarios.filter((scenario) =>
    scenarioDeclaresQaChannel(scenario, params.channelId),
  );
  const scenarios = resolveQaRunProfileExecutionSelection({
    scenarios: eligibleScenarios,
    providerMode,
    primaryModel,
    channelDriver: "live",
    channel: params.channelId,
    executionKind: "flow",
    resolveModuleFlowSupport: () => params.supportsModuleFlows === true,
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
