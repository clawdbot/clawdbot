// QA Lab WhatsApp live scenario catalog and selection.
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

export function getWhatsAppQaScenarioDefinition(id: string) {
  const scenario = WHATSAPP_QA_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`unknown WhatsApp QA scenario id: ${id}`);
  }
  return scenario;
}
