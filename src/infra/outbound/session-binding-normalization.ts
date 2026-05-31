import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../../routing/session-key.js";

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

export function normalizeConversationRef<T extends ConversationRefShape>(ref: T): T {
  const normalizedTarget = normalizeConversationTargetRef(ref);
  return {
    ...normalizedTarget,
    channel: normalizeLowercaseStringOrEmpty(ref.channel),
    accountId: normalizeAccountId(ref.accountId),
  };
}

export function buildChannelAccountKey(params: { channel: string; accountId: string }): string {
  return `${normalizeLowercaseStringOrEmpty(params.channel)}:${normalizeAccountId(params.accountId)}`;
}
