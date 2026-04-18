import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixTargetIdentity } from "./matrix/target-ids.js";

export const defaultTopLevelPlacement = "child" as const;

export function resolveMatrixInboundConversation(params: {
  to?: string;
  conversationId?: string;
  threadId?: string | number;
}) {
  const rawTarget = params.to?.trim() || params.conversationId?.trim() || "";
  const target = rawTarget ? resolveMatrixTargetIdentity(rawTarget) : null;
  const parentConversationId = target?.kind === "room" ? target.id : undefined;
  const threadId =
    params.threadId != null ? normalizeOptionalString(String(params.threadId)) : undefined;
  if (threadId) {
    return {
      conversationId: threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}
