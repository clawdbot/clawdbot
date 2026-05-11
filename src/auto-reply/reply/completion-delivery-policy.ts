import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deriveSessionChatType } from "../../sessions/session-chat-type.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

export type CompletionChatType = ChatType | "unknown";

export type CompletionDeliverySessionEntry = {
  chatType?: string | null;
  origin?: { chatType?: string | null } | null;
};

export function resolveCompletionChatType(params: {
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): CompletionChatType {
  const explicit = normalizeChatType(
    params.requesterEntry?.chatType ?? params.requesterEntry?.origin?.chatType ?? undefined,
  );
  if (explicit) {
    return explicit;
  }

  for (const key of [params.targetRequesterSessionKey, params.requesterSessionKey]) {
    const derived = deriveSessionChatType(key);
    if (derived !== "unknown") {
      return derived;
    }
  }

  return inferCompletionChatTypeFromTarget(
    params.directOrigin?.to ?? params.requesterSessionOrigin?.to,
  );
}

export function completionRequiresMessageToolDelivery(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string | null;
  targetRequesterSessionKey?: string | null;
  requesterEntry?: CompletionDeliverySessionEntry;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  messageToolAvailable?: boolean;
}): boolean {
  return (
    resolveSourceReplyDeliveryMode({
      cfg: params.cfg,
      ctx: {
        ChatType: resolveCompletionChatType(params),
      },
      messageToolAvailable: params.messageToolAvailable,
    }) === "message_tool_only"
  );
}

export function shouldRouteCompletionThroughRequesterSession(
  sessionKey: string | undefined | null,
): boolean {
  const chatType = deriveSessionChatType(sessionKey);
  return chatType === "group" || chatType === "channel";
}

function inferCompletionChatTypeFromTarget(to: string | undefined): CompletionChatType {
  const normalized = to?.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.startsWith("group:")) {
    return "group";
  }
  if (normalized.startsWith("channel:") || normalized.startsWith("thread:")) {
    return "channel";
  }
  if (
    normalized.startsWith("dm:") ||
    normalized.startsWith("direct:") ||
    normalized.startsWith("user:")
  ) {
    return "direct";
  }
  return "unknown";
}
