// Whatsapp plugin module implements inbound behavior.
export { resetWebInboundDedupe } from "./inbound/dedupe.js";
export { extractContactContext, extractLocationData, extractText } from "./inbound/extract.js";
export { monitorWebInbox } from "./inbound/monitor.js";
export type { WhatsAppInboundAdmission } from "./inbound/admission.js";
export type {
  LegacyFlatWebInboundMessage,
  WebInboundCallbackMessage,
  WebInboundMessage,
  WebInboundMessageInput,
  WebListenerCloseReason,
} from "./inbound/types.js";
