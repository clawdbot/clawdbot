/**
 * Conversation binding record facade.
 *
 * Routes binding CRUD helpers through the shared session binding service.
 */
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingBindInput,
  type SessionBindingRecord,
  type SessionBindingUnbindInput,
} from "../infra/outbound/session-binding-service.js";

export async function createConversationBindingRecord(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord> {
  return await getSessionBindingService().bind(input);
}

export function resolveConversationBindingRecord(
  conversation: ConversationRef,
): SessionBindingRecord | null {
  return getSessionBindingService().resolveByConversation(conversation);
}

export function touchConversationBindingRecord(bindingId: string, at?: number): void {
  const service = getSessionBindingService();
  if (typeof at === "number") {
    service.touch(bindingId, at);
    return;
  }
  service.touch(bindingId);
}

export async function unbindConversationBindingRecord(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  return await getSessionBindingService().unbind(input);
}
