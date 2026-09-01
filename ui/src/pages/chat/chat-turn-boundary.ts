import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem, MessageGroup, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";

export function safeNormalizeMessage(message: unknown): NormalizedMessage | null {
  if (!asRecord(message)) {
    return null;
  }
  try {
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

export function assistantGroupIsForwardedBoundary(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => {
    const provenance = asRecord(asRecord(message)?.provenance);
    return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
  });
}

// Display attribution also accepts projected source metadata; turn ownership
// above still requires the original sessions_send provenance.
export function hasForwardedSource(group: MessageGroup): boolean {
  return Boolean(group.senderSession) || assistantGroupIsForwardedBoundary(group);
}

function groupStartsProjectedTurnBoundary(group: MessageGroup): boolean {
  return asRecord(asRecord(group.messages[0]?.message)?.["__openclaw"])?.turnBoundary === true;
}

/** Canonical user-turn boundary shared by insertion, outcome, and collapse projections. */
export function chatItemStartsUserTurn(item: ChatItem | MessageGroup): boolean {
  if (item.kind === "notice") {
    return item.startsTurn === true;
  }
  if (item.kind === "message") {
    const normalized = safeNormalizeMessage(item.message);
    return normalized ? normalizeRoleForGrouping(normalized.role).toLowerCase() === "user" : false;
  }
  if (item.kind !== "group") {
    return false;
  }
  const role = item.role.toLowerCase();
  return (
    role === "user" ||
    groupStartsProjectedTurnBoundary(item) ||
    (role === "assistant" && assistantGroupIsForwardedBoundary(item))
  );
}
