import { beforeEach, describe, expect, it } from "vitest";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import {
  __testing,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

const TARGET_SESSION_KEY = "agent:main:subagent:child";

function createDiscordBinding(
  targetSessionKey: string,
  conversationId: string,
  boundAt: number,
  parentConversationId?: string,
): SessionBindingRecord {
  return {
    bindingId: `runtime:${conversationId}`,
    targetSessionKey,
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "runtime",
      conversationId,
      parentConversationId,
    },
    status: "active",
    boundAt,
  };
}

function registerDiscordSessionBindings(
  targetSessionKey: string,
  bindings: SessionBindingRecord[],
): void {
  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "runtime",
    listBySession: (requestedSessionKey) =>
      requestedSessionKey === targetSessionKey ? bindings : [],
    resolveByConversation: () => null,
  });
}

describe("bound delivery router", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  const resolveDestination = (params: {
    targetSessionKey?: string;
    bindings?: SessionBindingRecord[];
    requesterConversationId?: string;
    failClosed?: boolean;
  }) => {
    if (params.bindings) {
      registerDiscordSessionBindings(
        params.targetSessionKey ?? TARGET_SESSION_KEY,
        params.bindings,
      );
    }
    return createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: params.targetSessionKey ?? TARGET_SESSION_KEY,
      ...(params.requesterConversationId !== undefined
        ? {
            requester: {
              channel: "discord",
              accountId: "runtime",
              conversationId: params.requesterConversationId,
            },
          }
        : {}),
      failClosed: params.failClosed ?? false,
    });
  };

  it.each([
    {
      name: "resolves to a bound destination when a single active binding exists",
      bindings: [createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1, "parent-1")],
      requesterConversationId: "parent-1",
      expected: {
        mode: "bound",
      },
      expectedConversationId: "thread-1",
    },
    {
      name: "falls back when no active binding exists",
      targetSessionKey: "agent:main:subagent:missing",
      requesterConversationId: "parent-1",
      expected: {
        binding: null,
        mode: "fallback",
        reason: "no-active-binding",
      },
    },
    {
      name: "fails closed when multiple bindings exist without requester signal",
      bindings: [
        createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
        createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
      ],
      failClosed: true,
      expected: {
        binding: null,
        mode: "fallback",
        reason: "ambiguous-without-requester",
      },
    },
    {
      name: "selects requester-matching conversation when multiple bindings exist",
      bindings: [
        createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
        createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
      ],
      requesterConversationId: "thread-2",
      failClosed: true,
      expected: {
        mode: "bound",
        reason: "requester-match",
      },
      expectedConversationId: "thread-2",
    },
    {
      name: "normalizes adapter binding conversations before requester matching",
      bindings: [
        {
          ...createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
          conversation: {
            channel: " discord ",
            accountId: " runtime ",
            conversationId: " thread-1 ",
          },
        },
        {
          ...createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
          conversation: {
            channel: " DISCORD ",
            accountId: " Runtime ",
            conversationId: " thread-2 ",
          },
        },
      ],
      requesterConversationId: "thread-2",
      failClosed: true,
      expected: {
        mode: "bound",
        reason: "requester-match",
      },
      expectedConversationId: " thread-2 ",
    },
    {
      name: "falls back for invalid requester conversation values",
      bindings: [createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1)],
      requesterConversationId: " ",
      failClosed: true,
      expected: {
        binding: null,
        mode: "fallback",
        reason: "invalid-requester",
      },
    },
  ])(
    "$name",
    ({
      targetSessionKey,
      bindings,
      requesterConversationId,
      failClosed,
      expected,
      expectedConversationId,
    }) => {
      const route = resolveDestination({
        targetSessionKey,
        bindings,
        requesterConversationId,
        failClosed,
      });

      expect(route).toMatchObject(expected);
      if (expectedConversationId !== undefined) {
        expect(route.binding?.conversation.conversationId).toBe(expectedConversationId);
      }
    },
  );
});
