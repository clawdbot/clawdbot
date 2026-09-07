import { normalizeOptionalString as normalizeQaConfigString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import { splitQaModelRef, type QaProviderMode } from "./model-selection.js";
import {
  resolveQaScenarioRequiredProviderMode,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";

type QaSeedScenario = QaSeedScenarioWithSource;

export type QaScenarioExecutionCell = {
  scenarioId: string;
  executionKind: QaSeedScenario["execution"]["kind"];
  channel: string | null;
};

function resolveQaScenarioLaneChannels(params: {
  scenario: QaSeedScenario;
  channelDriver: QaScorecardChannelDriver;
  channel?: string | null;
  defaultChannel?: string;
  supportsChannel?: (channel: string) => boolean;
}): Array<string | undefined> {
  if (params.channelDriver === "qa-channel") {
    return ["qa-channel"];
  }
  const selectedChannel = params.channel?.trim().toLowerCase();
  if (selectedChannel) {
    return [selectedChannel];
  }
  const declaredChannels = params.scenario.execution.channels ?? [];
  if (declaredChannels.length === 1) {
    return declaredChannels;
  }
  if (params.scenario.execution.kind === "flow") {
    const driverChannels = declaredChannels.filter((channel) => channel !== "qa-channel");
    const supportedChannels = driverChannels.filter(
      (channel) => !params.supportsChannel || params.supportsChannel(channel),
    );
    if (supportedChannels.length) {
      return supportedChannels;
    }
    if (driverChannels.length) {
      return driverChannels;
    }
  }
  const defaultChannel = params.defaultChannel?.trim().toLowerCase();
  return [defaultChannel];
}

export function resolveQaScenarioLaneChannel(
  params: Parameters<typeof resolveQaScenarioLaneChannels>[0],
): string | undefined {
  return resolveQaScenarioLaneChannels(params)[0];
}

export function expandQaScenarioExecutionCells(
  params: {
    scenarios: readonly QaSeedScenario[];
    expandChannels: boolean;
  } & Omit<Parameters<typeof resolveQaScenarioLaneChannels>[0], "scenario">,
): QaScenarioExecutionCell[] {
  return params.scenarios.flatMap((scenario) => {
    const channels =
      scenario.execution.kind === "flow"
        ? params.expandChannels
          ? resolveQaScenarioLaneChannels({ ...params, scenario })
          : [resolveQaScenarioLaneChannel({ ...params, scenario })]
        : [undefined];
    return channels.map((channel) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      channel: channel ?? null,
    }));
  });
}

export function describeQaProviderLaneMismatches(params: {
  scenario: QaSeedScenario;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: QaScorecardChannelDriver | null;
  channel?: string | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  supportsModuleFlows?: boolean;
}) {
  const mismatches: string[] = [];
  const config = params.scenario.execution.config ?? {};
  const requiredProviderMode = resolveQaScenarioRequiredProviderMode(params.scenario);
  if (requiredProviderMode && params.providerMode !== requiredProviderMode) {
    mismatches.push(`providerMode=${requiredProviderMode}`);
  }
  const effectiveChannelDriver = params.channelDriver ?? "qa-channel";
  const requiredChannelDriver = normalizeQaConfigString(config.requiredChannelDriver);
  if (requiredChannelDriver && effectiveChannelDriver !== requiredChannelDriver) {
    mismatches.push(`channelDriver=${requiredChannelDriver}`);
  }
  const effectiveChannel =
    effectiveChannelDriver === "qa-channel"
      ? "qa-channel"
      : params.channel?.trim().toLowerCase() || undefined;
  const declaredChannels = params.scenario.execution.channels ?? [];
  if (declaredChannels.length > 0 && !declaredChannels.includes(effectiveChannel ?? "")) {
    mismatches.push(`channel=${declaredChannels.join("|")}`);
  }
  if (
    params.scenario.execution.kind === "flow" &&
    params.scenario.execution.flowKind === "module" &&
    params.supportsModuleFlows !== true
  ) {
    const implementation =
      effectiveChannel && effectiveChannel !== effectiveChannelDriver
        ? `${effectiveChannelDriver}:${effectiveChannel}`
        : effectiveChannelDriver;
    mismatches.push(`module flow unsupported by implementation=${implementation}`);
  }
  const selected = splitQaModelRef(params.primaryModel);
  const requiredProvider = normalizeQaConfigString(config.requiredProvider);
  if (requiredProvider && selected?.provider !== requiredProvider) {
    mismatches.push(`provider=${requiredProvider}`);
  }
  const requiredModel = normalizeQaConfigString(config.requiredModel);
  if (requiredModel && selected?.model !== requiredModel) {
    mismatches.push(`model=${requiredModel}`);
  }
  const requiredAuthMode = normalizeQaConfigString(config.authMode);
  if (requiredAuthMode && params.claudeCliAuthMode !== requiredAuthMode) {
    mismatches.push(`authMode=${requiredAuthMode}`);
  }
  return mismatches;
}

export function scenarioMatchesQaProviderLane(
  params: Parameters<typeof describeQaProviderLaneMismatches>[0],
) {
  return describeQaProviderLaneMismatches(params).length === 0;
}
