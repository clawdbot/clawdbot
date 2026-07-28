import type { QaProviderModeInput } from "../../model-selection.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";

export function resolveSlackQaScenarioIds(params: {
  profile?: string;
  providerMode?: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  return resolveLiveTransportQaScenarioIds({
    channelId: "slack",
    ...params,
    providerMode: params.providerMode ?? "live-frontier",
  });
}
