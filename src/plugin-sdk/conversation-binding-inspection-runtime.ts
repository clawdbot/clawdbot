import type { inspectSessionBindingByConversation } from "../infra/outbound/session-binding-service.js";

// Retain the public v2026.8.1 inspection contract over the canonical read-only owner.
export { inspectSessionBindingByConversation as inspectConversationBinding } from "../infra/outbound/session-binding-service.js";
export type ConversationBindingInspection = ReturnType<typeof inspectSessionBindingByConversation>;
