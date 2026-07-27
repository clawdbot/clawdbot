import type { QaProviderModeInput } from "../../model-selection.js";
import { resolveQaProfileScenarios } from "../../profile-selection.js";

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
