import {
  inspectSessionBindingByConversation,
  type ConversationRef,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";

/** Read-only result from the authoritative current-conversation binding store. */
export type ConversationBindingInspection =
  | { status: "available"; binding: SessionBindingRecord | null }
  | { status: "unavailable" };

/**
 * Inspect current-conversation binding state without refreshing binding liveness.
 * `unavailable` is distinct from an authoritative empty binding result.
 */
export function inspectConversationBinding(
  conversation: ConversationRef,
): ConversationBindingInspection {
  return inspectSessionBindingByConversation(conversation);
}
