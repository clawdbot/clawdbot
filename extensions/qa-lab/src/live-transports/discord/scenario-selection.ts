import type { QaProviderModeInput } from "../../model-selection.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";

export function resolveDiscordQaScenarioIds(params: {
  profile?: string;
  providerMode?: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  return resolveLiveTransportQaScenarioIds({
    channelId: "discord",
    ...params,
    providerMode: params.providerMode ?? "live-frontier",
  });
}
