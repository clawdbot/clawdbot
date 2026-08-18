import { asNullableRecord as recordOrNull } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";

export function clearTypingActorForSessionMessage(
  payload: unknown,
  actors: Map<string, unknown>,
  timers: Map<string, number>,
  matchesSession: (key: string, agentId?: string) => boolean,
): boolean {
  const event = readSessionChangedEvent(payload);
  if (!event || !matchesSession(event.key, event.agentId ?? undefined)) {
    return false;
  }
  return clearTypingActorForUserMessage(payload, actors, timers);
}

export function clearTypingActorForUserMessage(
  payload: unknown,
  actors: Map<string, unknown>,
  timers: Map<string, number>,
): boolean {
  const event = recordOrNull(payload);
  const message = recordOrNull(event?.message);
  if (stringValue(message?.role)?.toLowerCase() !== "user") {
    return false;
  }
  // Legacy senderLabel identity is display compatibility, not authority to
  // mutate live presence. Only the structured ingress identity may clear it.
  const actorId = stringValue(recordOrNull(message?.["__openclaw"])?.senderId);
  if (!actorId || !actors.delete(actorId)) {
    return false;
  }
  const timer = timers.get(actorId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(actorId);
  }
  return true;
}
