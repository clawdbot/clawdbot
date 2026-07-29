import type { QaProviderModeInput } from "../../model-selection.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";

export function resolveWhatsAppQaScenarioIds(params: {
  profile?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}) {
  return resolveLiveTransportQaScenarioIds({ channelId: "whatsapp", ...params });
}
