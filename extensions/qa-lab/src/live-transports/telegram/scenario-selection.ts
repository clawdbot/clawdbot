import type { QaProviderModeInput } from "../../model-selection.js";
import {
  resolveCatalogLiveTransportQaScenarioIds,
  listLiveTransportQaScenarios,
  resolveLiveTransportQaScenarioIds,
} from "../shared/scenario-selection.js";

const TELEGRAM_QA_CHANNEL_ID = "telegram";

export function resolveTelegramQaScenarioIds(params: {
  profile?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}): string[] {
  const selectedIds = resolveLiveTransportQaScenarioIds({
    channelId: TELEGRAM_QA_CHANNEL_ID,
    ...params,
  });
  const flowIds = new Set(
    resolveCatalogLiveTransportQaScenarioIds({
      channelId: TELEGRAM_QA_CHANNEL_ID,
      providerMode: params.providerMode,
    }),
  );
  const unsupportedIds = selectedIds.filter((scenarioId) => !flowIds.has(scenarioId));
  if (params.scenarioIds?.length && unsupportedIds.length > 0) {
    throw new Error(
      `Telegram QA flow runner cannot execute non-flow scenario(s): ${unsupportedIds.join(", ")}`,
    );
  }
  const scenarioIds = selectedIds.filter((scenarioId) => flowIds.has(scenarioId));
  if (scenarioIds.length === 0) {
    throw new Error("Telegram QA flow selection resolved no scenarios.");
  }
  return scenarioIds;
}

export function listTelegramQaScenarios(providerMode: QaProviderModeInput) {
  const flowIds = new Set(
    resolveCatalogLiveTransportQaScenarioIds({
      channelId: TELEGRAM_QA_CHANNEL_ID,
      providerMode,
    }),
  );
  return listLiveTransportQaScenarios({
    channelId: TELEGRAM_QA_CHANNEL_ID,
    providerMode,
  }).filter((scenario) => flowIds.has(scenario.id));
}
