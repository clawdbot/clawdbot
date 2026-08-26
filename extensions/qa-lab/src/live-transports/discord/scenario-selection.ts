import type { QaProviderModeInput } from "../../model-selection.js";
import type { QaScorecardChannelDriver } from "../../scorecard-taxonomy.js";
import { resolveTransportQaScenarioIds } from "../shared/scenario-selection.js";

export function resolveDiscordQaScenarioIds(params: {
  profile?: string;
  channelDriver?: QaScorecardChannelDriver;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  return resolveTransportQaScenarioIds({
    channelId: "discord",
    ...params,
    channelDriver: params.channelDriver ?? "live",
    providerMode: params.providerMode ?? "live-frontier",
    supportsModuleFlows: true,
  });
}
