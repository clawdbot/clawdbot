function normalizeLineConversationId(raw?: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const prefixed = trimmed.match(/^line:(?:(?:user|group|room):)?(.+)$/i)?.[1];
  return (prefixed ?? trimmed).trim() || null;
}

function resolveLineCommandConversation(params: {
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const conversationId =
    normalizeLineConversationId(params.originatingTo) ??
    normalizeLineConversationId(params.commandTo) ??
    normalizeLineConversationId(params.fallbackTo);
  return conversationId ? { conversationId } : null;
}

function resolveLineInboundConversation(params: { to?: string; conversationId?: string }) {
  const conversationId =
    normalizeLineConversationId(params.conversationId) ?? normalizeLineConversationId(params.to);
  return conversationId ? { conversationId } : null;
}

export const lineBindingsAdapter = {
  compileConfiguredBinding: ({ conversationId }: { conversationId?: string }) => {
    const normalized = normalizeLineConversationId(conversationId);
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({
    compiledBinding,
    conversationId,
  }: {
    compiledBinding: { conversationId: string };
    conversationId?: string;
  }) => {
    const normalizedIncoming = normalizeLineConversationId(conversationId);
    if (!normalizedIncoming || compiledBinding.conversationId !== normalizedIncoming) {
      return null;
    }
    return {
      conversationId: normalizedIncoming,
      matchPriority: 2,
    };
  },
  resolveCommandConversation: ({
    originatingTo,
    commandTo,
    fallbackTo,
  }: {
    originatingTo?: string;
    commandTo?: string;
    fallbackTo?: string;
  }) =>
    resolveLineCommandConversation({
      originatingTo,
      commandTo,
      fallbackTo,
    }),
  resolveInboundConversation: ({ to, conversationId }: { to?: string; conversationId?: string }) =>
    resolveLineInboundConversation({ to, conversationId }),
};
