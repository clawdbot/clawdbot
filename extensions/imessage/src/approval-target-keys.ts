// Conversation-key plumbing shared by the tapback and poll approval bindings.
// Both bind an approval to an outbound message GUID in a conversation, and both
// must survive the outbound/inbound key asymmetry described on
// enumerateApprovalTargetKeys. Kept transport-neutral so neither binding module
// depends on the other.
import { normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

export type IMessageApprovalConversationKey = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number | string;
  /** Direct-message handle (already normalized via normalizeIMessageHandle). */
  handle?: string;
};

/** Strip the `p:<n>/` part prefix Messages puts on some GUIDs so keys match. */
export function normalizeIMessageGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}

function chatIdToKeyValue(chatId: number | string | undefined): string | null {
  if (chatId == null || chatId === "") {
    return null;
  }
  if (typeof chatId === "number") {
    // chat.db ROWID is always > 0; treat 0 as "missing" rather than a valid key.
    return Number.isFinite(chatId) && chatId > 0 ? String(chatId) : null;
  }
  const value = chatId.trim();
  return value || null;
}

export function enumerateConversationKeyForms(
  conversation: IMessageApprovalConversationKey,
): string[] {
  const forms: string[] = [];
  const chatGuid = conversation.chatGuid?.trim();
  if (chatGuid) {
    forms.push(`chat_guid:${chatGuid}`);
  }
  const chatIdentifier = conversation.chatIdentifier?.trim();
  if (chatIdentifier) {
    forms.push(`chat_identifier:${chatIdentifier}`);
  }
  const chatIdValue = chatIdToKeyValue(conversation.chatId);
  if (chatIdValue) {
    forms.push(`chat_id:${chatIdValue}`);
  }
  const handle = conversation.handle?.trim();
  if (handle) {
    forms.push(`handle:${handle}`);
  }
  return forms;
}

export function normalizeConversationKey(
  conversation: IMessageApprovalConversationKey,
): string | undefined {
  return enumerateConversationKeyForms(conversation)[0];
}

/**
 * Index a binding under every key derivable from the conversation. Outbound and
 * inbound disagree about which key exists: send may only know
 * `{handle: "+1..."}` for a DM, while the bridge populates chat_guid on the
 * inbound event. Enumerating all forms keeps the two symmetric without making
 * callers guess which one the bridge will pick.
 */
export function enumerateApprovalTargetKeys(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
}): string[] {
  const accountId = params.accountId.trim();
  const messageId = params.messageId.trim();
  if (!accountId || !messageId) {
    return [];
  }
  return enumerateConversationKeyForms(params.conversation).map(
    (form) => `${accountId}:${form}:${messageId}`,
  );
}

export function buildIMessageApprovalConversationKeyForTarget(
  to: string,
): IMessageApprovalConversationKey | null {
  try {
    const target = parseIMessageTarget(to);
    if (target.kind === "chat_id") {
      return { chatId: target.chatId };
    }
    if (target.kind === "chat_guid") {
      return { chatGuid: target.chatGuid };
    }
    if (target.kind === "chat_identifier") {
      return { chatIdentifier: target.chatIdentifier };
    }
    const handle = normalizeIMessageHandle(target.to);
    return handle ? { handle } : null;
  } catch {
    return null;
  }
}

/** Conversation key for an inbound event, mirroring the outbound key forms. */
export function buildIMessageApprovalConversationKeyForInbound(params: {
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  chatId?: number | string | null;
  isGroup?: boolean | null;
  actorHandle: string;
}): IMessageApprovalConversationKey {
  return {
    ...(params.chatGuid?.trim() ? { chatGuid: params.chatGuid.trim() } : {}),
    ...(params.chatIdentifier?.trim() ? { chatIdentifier: params.chatIdentifier.trim() } : {}),
    ...(chatIdToKeyValue(params.chatId ?? undefined) ? { chatId: params.chatId as number } : {}),
    // Group sends are keyed by chat only: the actor handle is a member, not the
    // conversation, so including it would never match the outbound key.
    ...(params.isGroup ? {} : { handle: params.actorHandle }),
  };
}
