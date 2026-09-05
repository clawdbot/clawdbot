import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";

export function createConfiguredAcpTopicBinding(boundSessionKey: string) {
  return {
    spec: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 0,
    },
  } as const;
}

export function createConfiguredBindingRoute(
  route: ResolvedAgentRoute,
  binding: ReturnType<typeof createConfiguredAcpTopicBinding> | null,
) {
  return {
    bindingResolution: binding
      ? {
          conversation: binding.record.conversation,
          compiledBinding: {
            channel: "telegram" as const,
            binding: {
              type: "acp" as const,
              agentId: binding.spec.agentId,
              match: {
                channel: "telegram",
                accountId: binding.spec.accountId,
                peer: {
                  kind: "group" as const,
                  id: binding.spec.conversationId,
                },
              },
              acp: {
                mode: binding.spec.mode,
              },
            },
            bindingConversationId: binding.spec.conversationId,
            target: {
              conversationId: binding.spec.conversationId,
              ...(binding.spec.parentConversationId
                ? { parentConversationId: binding.spec.parentConversationId }
                : {}),
            },
            agentId: binding.spec.agentId,
            provider: {
              compileConfiguredBinding: () => ({
                conversationId: binding.spec.conversationId,
                ...(binding.spec.parentConversationId
                  ? { parentConversationId: binding.spec.parentConversationId }
                  : {}),
              }),
              matchInboundConversation: () => ({
                conversationId: binding.spec.conversationId,
                ...(binding.spec.parentConversationId
                  ? { parentConversationId: binding.spec.parentConversationId }
                  : {}),
              }),
            },
            targetFactory: {
              driverId: "acp" as const,
              materialize: () => ({
                record: binding.record,
                statefulTarget: {
                  kind: "stateful" as const,
                  driverId: "acp" as const,
                  sessionKey: binding.record.targetSessionKey,
                  agentId: binding.spec.agentId,
                },
              }),
            },
          },
          match: {
            conversationId: binding.spec.conversationId,
            ...(binding.spec.parentConversationId
              ? { parentConversationId: binding.spec.parentConversationId }
              : {}),
          },
          record: binding.record,
          statefulTarget: {
            kind: "stateful" as const,
            driverId: "acp" as const,
            sessionKey: binding.record.targetSessionKey,
            agentId: binding.spec.agentId,
          },
        }
      : null,
    ...(binding ? { boundSessionKey: binding.record.targetSessionKey } : {}),
    route,
  };
}
