// Session-binding normalization creates stable channel/account/conversation keys
// and removes invalid self-parent relationships.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../../routing/session-key.js";

/**
 * Minimal conversation shape normalized before binding lookup or storage.
 */
export type ConversationRefShape = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

type ConversationTargetRefShape = {
  conversationId: string;
  parentConversationId?: string | null;
};

/**
 * Normalizes conversation ids and drops self-referential parent ids.
 */
export function normalizeConversationTargetRef<T extends ConversationTargetRefShape>(ref: T): T {
  const conversationId = normalizeOptionalString(ref.conversationId) ?? "";
  const parentConversationId = normalizeOptionalString(ref.parentConversationId);
  const { parentConversationId: _ignoredParentConversationId, ...rest } = ref;
  return {
    ...rest,
    conversationId,
    ...(parentConversationId && parentConversationId !== conversationId
      ? { parentConversationId }
      : {}),
  } as T;
}

/**
 * Normalizes a full conversation reference for stable binding keys.
 */
export function normalizeConversationRef<T extends ConversationRefShape>(ref: T): T {
  const normalizedTarget = normalizeConversationTargetRef(ref);
  return {
    ...normalizedTarget,
    channel: normalizeLowercaseStringOrEmpty(ref.channel),
    accountId: normalizeAccountId(ref.accountId),
  };
}

/**
 * Builds the adapter registry key shared by channel/account scoped bindings.
 */
export function buildChannelAccountKey(params: { channel: string; accountId: string }): string {
  return `${normalizeLowercaseStringOrEmpty(params.channel)}:${normalizeAccountId(params.accountId)}`;
}
