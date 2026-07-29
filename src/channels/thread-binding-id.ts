// Thread binding id parsing helpers for account-scoped conversation bindings.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Parses an account-prefixed binding id back into a conversation id. */
export function resolveThreadBindingConversationIdFromBindingId(params: {
  accountId: string;
  bindingId?: string;
}): string | undefined {
  const bindingId = normalizeOptionalString(params.bindingId);
  if (!bindingId) {
    return undefined;
  }
  const prefix = `${params.accountId}:`;
  if (!bindingId.startsWith(prefix)) {
    return undefined;
  }
  const conversationId = normalizeOptionalString(bindingId.slice(prefix.length));
  return conversationId || undefined;
}
