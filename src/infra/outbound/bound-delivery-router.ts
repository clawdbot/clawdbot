import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingRecord,
  type SessionBindingService,
} from "./session-binding-service.js";

export type BoundDeliveryRouterInput = {
  eventKind: "task_completion";
  targetSessionKey: string;
  requester?: ConversationRef;
  failClosed: boolean;
};

export type BoundDeliveryRouterResult = {
  binding: SessionBindingRecord | null;
  mode: "bound" | "fallback";
  reason: string;
};

export type BoundDeliveryRouter = {
  resolveDestination: (input: BoundDeliveryRouterInput) => BoundDeliveryRouterResult;
};

function isActiveBinding(record: SessionBindingRecord): boolean {
  return record.status === "active";
}

function resolveBindingForRequester(
  requester: ConversationRef,
  bindings: SessionBindingRecord[],
): SessionBindingRecord | null {
  const matchingChannelAccount = bindings.filter((entry) => {
    const conversation = normalizeConversationRef(entry.conversation);
    return (
      conversation.channel === requester.channel && conversation.accountId === requester.accountId
    );
  });
  if (matchingChannelAccount.length === 0) {
    return null;
  }

  const exactConversation = matchingChannelAccount.find(
    (entry) =>
      normalizeConversationRef(entry.conversation).conversationId === requester.conversationId,
  );
  if (exactConversation) {
    return exactConversation;
  }

  if (matchingChannelAccount.length === 1) {
    return matchingChannelAccount[0] ?? null;
  }
  return null;
}

export function createBoundDeliveryRouter(
  service: SessionBindingService = getSessionBindingService(),
): BoundDeliveryRouter {
  return {
    resolveDestination: (input) => {
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return {
          binding: null,
          mode: "fallback",
          reason: "missing-target-session",
        };
      }

      const activeBindings = service.listBySession(targetSessionKey).filter(isActiveBinding);
      if (activeBindings.length === 0) {
        return {
          binding: null,
          mode: "fallback",
          reason: "no-active-binding",
        };
      }

      if (!input.requester) {
        if (activeBindings.length === 1) {
          return {
            binding: activeBindings[0] ?? null,
            mode: "bound",
            reason: "single-active-binding",
          };
        }
        return {
          binding: null,
          mode: "fallback",
          reason: "ambiguous-without-requester",
        };
      }

      const requester: ConversationRef = normalizeConversationRef(input.requester);
      if (!requester.channel || !requester.conversationId) {
        return {
          binding: null,
          mode: "fallback",
          reason: "invalid-requester",
        };
      }

      const fromRequester = resolveBindingForRequester(requester, activeBindings);
      if (fromRequester) {
        return {
          binding: fromRequester,
          mode: "bound",
          reason: "requester-match",
        };
      }

      if (activeBindings.length === 1 && !input.failClosed) {
        return {
          binding: activeBindings[0] ?? null,
          mode: "bound",
          reason: "single-active-binding-fallback",
        };
      }

      return {
        binding: null,
        mode: "fallback",
        reason: "no-requester-match",
      };
    },
  };
}
