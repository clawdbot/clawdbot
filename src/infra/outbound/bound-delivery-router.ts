import { normalizeConversationRef } from "./session-binding-normalization.js";
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingRecord,
  type SessionBindingService,
} from "./session-binding-service.js";

/** Session-bound delivery lookup input for routing task completion messages. */
export type BoundDeliveryRouterInput = {
  eventKind: "task_completion";
  targetSessionKey: string;
  requester?: ConversationRef;
  failClosed: boolean;
};

/** Resolved session binding or the fallback reason used by delivery callers. */
export type BoundDeliveryRouterResult = {
  binding: SessionBindingRecord | null;
  mode: "bound" | "fallback";
  reason: string;
};

/** Router facade that maps a target session/requester pair to a bound conversation. */
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

/** Creates a router that resolves task-completion delivery through active session bindings. */
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
        if (input.failClosed) {
          return {
            binding: null,
            mode: "fallback",
            reason: "missing-requester",
          };
        }
        if (activeBindings.length === 1) {
          return {
            binding: activeBindings[0] ?? null,
            mode: "bound",
            reason: "single-active-binding",
          };
        }
        // Without requester context, multiple active bindings are ambiguous;
        // fallback avoids leaking one session's completion into another chat.
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
