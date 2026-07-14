// QA Lab WhatsApp live scenario catalog and selection.
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import type { QaProviderMode } from "../../run-config.js";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
} from "../shared/live-transport-scenarios.js";
import type { WhatsAppQaScenarioDefinition } from "./whatsapp-live.contracts.js";
import { WHATSAPP_QA_CAPABILITY_SCENARIOS } from "./whatsapp-live.scenarios.capabilities.js";
import { WHATSAPP_QA_CONVERSATION_SCENARIOS } from "./whatsapp-live.scenarios.conversation.js";
import { WHATSAPP_QA_DELIVERY_SCENARIOS } from "./whatsapp-live.scenarios.delivery.js";
import { WHATSAPP_QA_USER_PATH_SCENARIOS } from "./whatsapp-live.scenarios.user-path.js";

const WHATSAPP_QA_SCENARIOS: WhatsAppQaScenarioDefinition[] = [
  ...WHATSAPP_QA_CONVERSATION_SCENARIOS,
  ...WHATSAPP_QA_USER_PATH_SCENARIOS,
  ...WHATSAPP_QA_CAPABILITY_SCENARIOS,
  ...WHATSAPP_QA_DELIVERY_SCENARIOS,
];

export const WHATSAPP_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  scenarios: WHATSAPP_QA_SCENARIOS,
});

export function listWhatsAppQaScenarioCatalog() {
  return WHATSAPP_QA_SCENARIOS.map((scenario) => ({ id: scenario.id }));
}

function shouldRunWhatsAppScenarioByDefault(
  scenario: WhatsAppQaScenarioDefinition,
  providerMode: QaProviderMode,
) {
  if (scenario.defaultEnabled === false) {
    return false;
  }
  if (scenario.standardId) {
    return true;
  }
  return Boolean(scenario.defaultProviderModes?.includes(providerMode));
}

export function findScenarios(
  ids?: string[],
  providerMode: QaProviderMode = DEFAULT_QA_LIVE_PROVIDER_MODE,
) {
  const scenarios =
    ids && ids.length > 0
      ? WHATSAPP_QA_SCENARIOS
      : WHATSAPP_QA_SCENARIOS.filter((scenario) =>
          shouldRunWhatsAppScenarioByDefault(scenario, providerMode),
        );
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "WhatsApp",
    scenarios,
  });
}

export function buildWhatsAppQaMockAuthAgentIds(scenario: WhatsAppQaScenarioDefinition) {
  return uniqueStrings([
    "main",
    "qa",
    ...normalizeStringEntries(scenario.configOverrides?.broadcast?.agents ?? []),
  ]);
}
