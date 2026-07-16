import type { QaCliBackendAuthMode } from "./gateway-child.js";
import { splitQaModelRef, type QaProviderMode } from "./model-selection.js";
import { getQaProvider } from "./providers/index.js";
import type { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";

type QaSeedScenario = ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];

function normalizeQaConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function describeQaProviderLaneMismatches(params: {
  scenario: QaSeedScenario;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: QaScorecardChannelDriver | null;
  channel?: string | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const mismatches: string[] = [];
  const provider = getQaProvider(params.providerMode);
  if (params.scenario.runtimeParityTier === "live-only" && provider.kind !== "live") {
    mismatches.push("live provider mode");
  }
  const config = params.scenario.execution.config ?? {};
  const requiredProviderMode = normalizeQaConfigString(config.requiredProviderMode);
  if (requiredProviderMode && params.providerMode !== requiredProviderMode) {
    mismatches.push(`providerMode=${requiredProviderMode}`);
  }
  const effectiveChannelDriver = params.channelDriver ?? "qa-channel";
  const effectiveChannel =
    effectiveChannelDriver === "qa-channel"
      ? "qa-channel"
      : params.channel?.trim().toLowerCase() || undefined;
  const scenarioChannel = params.scenario.execution.channel?.trim().toLowerCase();
  if (scenarioChannel && effectiveChannel !== scenarioChannel) {
    mismatches.push(`channel=${scenarioChannel}`);
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
