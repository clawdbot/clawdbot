// Qa Lab plugin module owns canonical runtime-pair-lane scenario selection.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import type { QaProviderMode } from "./model-selection.js";
import {
  readQaScenarioPack,
  type QaRuntimePairLane,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import { scenarioMatchesQaProviderLane } from "./scenario-lane.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";

export function resolveQaRuntimePairScenarioSupport(
  scenarios: readonly QaSeedScenarioWithSource[],
) {
  return {
    selectedScenarios: scenarios.filter((scenario) => scenario.execution.kind === "flow"),
    excludedScenarios: scenarios.filter((scenario) => scenario.execution.kind !== "flow"),
  };
}

export function resolveQaRuntimePairLaneScenarioIds(params: {
  channel?: string | null;
  channelDriver?: QaScorecardChannelDriver | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  defaultChannel?: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  scenarioIds: string[];
  scenarios?: QaSeedScenarioWithSource[];
  runtimePairLanes: readonly QaRuntimePairLane[];
  runtimePair: boolean;
  resolveModuleFlowSupport?: (channel?: string) => boolean;
}): {
  scenarioIds: string[];
  excludedLaneScenarios: QaSeedScenarioWithSource[];
  excludedNonFlowScenarios: QaSeedScenarioWithSource[];
} {
  if (params.runtimePairLanes.length === 0) {
    return {
      scenarioIds: params.scenarioIds,
      excludedLaneScenarios: [],
      excludedNonFlowScenarios: [],
    };
  }
  const laneSet = new Set(params.runtimePairLanes);
  const matchingScenarios = (params.scenarios ?? readQaScenarioPack().scenarios).filter(
    (scenario) => scenario.runtimePairLane && laneSet.has(scenario.runtimePairLane),
  );
  if (matchingScenarios.length === 0) {
    throw new Error(
      `--runtime-pair-lane matched no scenarios for ${params.runtimePairLanes.join(", ")}.`,
    );
  }
  const compatibleScenarios = params.runtimePair
    ? matchingScenarios.filter((scenario) => scenario.execution.kind === "flow")
    : matchingScenarios;
  const laneCompatibleScenarios = compatibleScenarios.filter((scenario) =>
    scenarioMatchesQaProviderLane({
      scenario,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      channelDriver: params.channelDriver,
      channel: params.channel ?? scenario.execution.channel ?? params.defaultChannel,
      claudeCliAuthMode: params.claudeCliAuthMode,
      supportsModuleFlows: params.resolveModuleFlowSupport?.(
        params.channel ?? scenario.execution.channel ?? params.defaultChannel,
      ),
    }),
  );
  const excludedLaneScenarios = compatibleScenarios.filter(
    (scenario) => !laneCompatibleScenarios.includes(scenario),
  );
  const excludedNonFlowScenarios = params.runtimePair
    ? matchingScenarios.filter((scenario) => scenario.execution.kind !== "flow")
    : [];
  if (compatibleScenarios.length === 0) {
    throw new Error(
      `--runtime-pair-lane matched no execution.kind: flow scenarios for ${params.runtimePairLanes.join(", ")}; incompatible scenario(s): ${excludedNonFlowScenarios.map((scenario) => `${scenario.id} (${scenario.execution.kind})`).join(", ")}.`,
    );
  }
  if (params.scenarioIds.length === 0 && laneCompatibleScenarios.length === 0) {
    throw new Error(
      `--runtime-pair-lane matched no scenarios for provider mode ${params.providerMode}; incompatible scenario(s): ${excludedLaneScenarios.map((scenario) => scenario.id).join(", ")}.`,
    );
  }
  return {
    scenarioIds: uniqueStrings([
      ...params.scenarioIds,
      ...laneCompatibleScenarios.map((scenario) => scenario.id),
    ]),
    excludedLaneScenarios,
    excludedNonFlowScenarios,
  };
}
