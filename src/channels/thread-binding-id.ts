import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

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
