import type { QaProviderModeInput } from "../../model-selection.js";
import {
  listLiveTransportQaScenarios,
  resolveLiveTransportQaScenarioIds,
} from "../shared/scenario-selection.js";

const TELEGRAM_QA_CHANNEL_ID = "telegram";

export function resolveTelegramQaScenarioIds(params: {
  profile?: string;
  primaryModel?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}): string[] {
  return resolveLiveTransportQaScenarioIds({ channelId: TELEGRAM_QA_CHANNEL_ID, ...params });
}

export function listTelegramQaScenarios(params: {
  primaryModel?: string;
  providerMode: QaProviderModeInput;
}) {
  return listLiveTransportQaScenarios({
    channelId: TELEGRAM_QA_CHANNEL_ID,
    ...params,
  });
}
