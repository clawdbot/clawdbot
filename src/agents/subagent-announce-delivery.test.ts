import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  __testing,
  deliverSubagentAnnouncement,
  extractThreadCompletionFallbackText,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import {
  callGateway as runtimeCallGateway,
  sendMessage as runtimeSendMessage,
} from "./subagent-announce-delivery.runtime.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";

afterEach(() => {
  resetAnnounceQueuesForTests();
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  __testing.setDepsForTest();
});

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

function createGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async () => response) as unknown as typeof runtimeCallGateway;
}

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

async function deliverSlackThreadAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive: boolean;
  sessionId: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  queueEmbeddedPiMessage?: (sessionId: string, message: string) => boolean;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
}) {
  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId,
      isActive: params.isActive,
    }),
    getRuntimeConfig: () => ({}) as never,
    ...(params.queueEmbeddedPiMessage
      ? { queueEmbeddedPiMessage: params.queueEmbeddedPiMessage }
      : {}),
    ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: slackThreadOrigin,
    requesterSessionOrigin: slackThreadOrigin,
    completionDirectOrigin: slackThreadOrigin,
    directOrigin: slackThreadOrigin,
    requesterIsSubagent: false,
    expectsCompletionMessage: params.expectsCompletionMessage,
    bestEffortDeliver: true,
    directIdempotencyKey: params.directIdempotencyKey,
    internalEvents: params.internalEvents,
  });
}

async function deliverDiscordDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
}) {
  const origin = {
    channel: "discord",
    to: "dm:U123",
    accountId: "acct-1",
  };
  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-dm",
      isActive: false,
    }),
    getRuntimeConfig: () => ({}) as never,
    ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:discord:dm:U123",
    targetRequesterSessionKey: "agent:main:discord:dm:U123",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: origin,
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-dm-fallback-empty",
    internalEvents: params.internalEvents,
  });
}

async function deliverTelegramDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  isActive?: boolean;
  queueEmbeddedPiMessage?: (sessionId: string, message: string) => boolean;
}) {
  const origin = {
    channel: "telegram",
    to: "123456789",
    accountId: "bot-1",
  };
  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-telegram",
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => ({}) as never,
    ...(params.queueEmbeddedPiMessage
      ? { queueEmbeddedPiMessage: params.queueEmbeddedPiMessage }
      : {}),
    ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:telegram:123456789",
    targetRequesterSessionKey: "agent:main:telegram:123456789",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: origin,
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-telegram-dm-fallback",
    internalEvents: params.internalEvents,
  });
}

async function deliverSlackChannelAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive: boolean;
  sessionId: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  queueEmbeddedPiMessage?: (sessionId: string, message: string) => boolean;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
}) {
  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
  } as const;

  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId,
      isActive: params.isActive,
    }),
    getRuntimeConfig: () => ({}) as never,
    ...(params.queueEmbeddedPiMessage
      ? { queueEmbeddedPiMessage: params.queueEmbeddedPiMessage }
      : {}),
    ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:slack:channel:C123",
    targetRequesterSessionKey: "agent:main:slack:channel:C123",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: origin,
    requesterSessionOrigin: origin,
    completionDirectOrigin: params.completionDirectOrigin ?? origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: params.expectsCompletionMessage,
    bestEffortDeliver: true,
    directIdempotencyKey: params.directIdempotencyKey,
    internalEvents: params.internalEvents,
  });
}

describe("resolveAnnounceOrigin threaded route targets", () => {
  it("preserves stored thread ids when requester origin omits one for the same chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "topicchat",
          lastTo: "topicchat:room-a:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "topicchat",
          to: "topicchat:room-a",
        },
      ),
    ).toEqual({
      channel: "topicchat",
      to: "topicchat:room-a",
      threadId: 99,
    });
  });

  it("preserves stored thread ids for group-prefixed requester targets", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "topicchat",
          lastTo: "topicchat:room-a:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "topicchat",
          to: "group:room-a",
        },
      ),
    ).toEqual({
      channel: "topicchat",
      to: "group:room-a",
      threadId: 99,
    });
  });

  it("still strips stale thread ids when the stored route points at a different chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "topicchat",
          lastTo: "topicchat:room-b:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "topicchat",
          to: "topicchat:room-a",
        },
      ),
    ).toEqual({
      channel: "topicchat",
      to: "topicchat:room-a",
    });
  });
});

describe("resolveSubagentCompletionOrigin", () => {
  it("resolves bound completion delivery from the requester session, not the child session", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "bot-alpha",
      listBySession: (targetSessionKey: string) => {
        if (targetSessionKey === "agent:worker:subagent:child") {
          return [
            {
              bindingId: "discord:bot-alpha:child-window",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "discord",
                accountId: "bot-alpha",
                conversationId: "child-window",
              },
              status: "active",
              boundAt: 1,
            },
          ];
        }
        return [];
      },
      resolveByConversation: () => null,
    });
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "acct-1",
      listBySession: (targetSessionKey: string) => {
        if (targetSessionKey === "agent:main:main") {
          return [
            {
              bindingId: "discord:acct-1:parent-main",
              targetSessionKey,
              targetKind: "session",
              conversation: {
                channel: "discord",
                accountId: "acct-1",
                conversationId: "parent-main",
              },
              status: "active",
              boundAt: 1,
            },
          ];
        }
        return [];
      },
      resolveByConversation: () => null,
    });

    const origin = await resolveSubagentCompletionOrigin({
      childSessionKey: "agent:worker:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "discord",
        accountId: "acct-1",
        to: "channel:parent-main",
      },
      spawnMode: "session",
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual({
      channel: "discord",
      accountId: "acct-1",
      to: "channel:parent-main",
    });
  });
});

describe("deliverSubagentAnnouncement queued delivery", () => {
  async function deliverQueuedAnnouncement(params: {
    requesterOrigin?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    };
  }) {
    const callGateway = createGatewayMock();
    let activityChecks = 0;
    __testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: activityChecks++ === 0,
      }),
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: "followup",
              debounceMs: 0,
            },
          },
        }) as never,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:eng:paperclip:issue:123",
      targetRequesterSessionKey: "agent:eng:paperclip:issue:123",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterOrigin: params.requesterOrigin,
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-no-external-route",
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "queued",
      }),
    );
    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(1));
    return callGateway;
  }

  it("keeps queued announces with no external route session-only", async () => {
    const callGateway = await deliverQueuedAnnouncement({});

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: "agent:eng:paperclip:issue:123",
          deliver: false,
          channel: undefined,
          accountId: undefined,
          to: undefined,
          threadId: undefined,
        }),
      }),
    );
  });

  it("keeps queued announces with channel-only origins session-only", async () => {
    const callGateway = await deliverQueuedAnnouncement({
      requesterOrigin: {
        channel: "slack",
      },
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: false,
          channel: undefined,
          to: undefined,
        }),
      }),
    );
  });

  it("keeps queued announces with internal origins session-only", async () => {
    const callGateway = await deliverQueuedAnnouncement({
      requesterOrigin: {
        channel: "webchat",
        to: "internal:room",
        accountId: "acct-1",
        threadId: "thread-1",
      },
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: false,
          channel: undefined,
          accountId: undefined,
          to: undefined,
          threadId: undefined,
        }),
      }),
    );
  });

  it("preserves queued external route fields when channel and target are present", async () => {
    const callGateway = await deliverQueuedAnnouncement({
      requesterOrigin: {
        channel: "slack",
        to: "channel:C123",
        accountId: "acct-1",
        threadId: "171.222",
      },
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
        }),
      }),
    );
  });
});

describe("deliverSubagentAnnouncement completion delivery", () => {
  it("keeps completion announces session-internal while preserving route context for active requesters", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedPiMessage = vi.fn(() => true);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-1",
      queueEmbeddedPiMessage,
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "steered",
      }),
    );
    expect(queueEmbeddedPiMessage).toHaveBeenCalledWith("requester-session-1", "child done", {
      steeringMode: "all",
      debounceMs: 500,
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps direct external delivery for dormant completion requesters", async () => {
    const callGateway = createGatewayMock();
    await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-2",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-1b",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
          bestEffortDeliver: true,
        }),
      }),
    );
  });

  it("keeps announce-agent delivery primary for dormant completion events with child output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "requester voice completion" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-1",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "thread completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct",
      }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
          bestEffortDeliver: true,
          internalEvents: expect.any(Array),
        }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses a direct thread fallback when announce-agent delivery fails", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("UNAVAILABLE: gateway lost final output");
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-1",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "thread completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-thread-fallback",
      }),
    );
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        threadId: "171.222",
        content: "child completion output",
        requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        bestEffort: true,
        idempotencyKey: "announce-thread-fallback-1",
      }),
    );
  });

  it("uses direct fallback for Telegram DMs when announce-agent delivery fails", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("UNAVAILABLE: requester wake failed");
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "telegram completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-fallback",
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "bot-1",
        to: "123456789",
        threadId: undefined,
        content: "child completion output",
        requesterSessionKey: "agent:main:telegram:123456789",
        bestEffort: true,
        idempotencyKey: "announce-telegram-dm-fallback",
      }),
    );
  });

  it("uses direct fallback when an active Telegram requester cannot be woken", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessage = vi.fn(() => false);
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      isActive: true,
      queueEmbeddedPiMessage,
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "telegram wake smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-fallback",
      }),
    );
    expect(queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "requester-session-telegram",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
      },
    );
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456789",
        content: "child completion output",
      }),
    );
  });

  it("uses a direct thread fallback when announce-agent returns no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-empty",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "thread completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-thread-fallback",
      }),
    );
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "child completion output",
        idempotencyKey: "announce-thread-fallback-empty",
      }),
    );
  });

  it("uses direct fallback for completion DMs without a thread id when announce-agent returns no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          childSessionId: "task-123",
          announceType: "music generation task",
          taskLabel: "night-drive synthwave",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
          mediaUrls: ["/tmp/generated-night-drive.mp3"],
          replyInstruction: "Deliver the generated music.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-fallback",
      }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "discord",
          accountId: "acct-1",
          to: "dm:U123",
          threadId: undefined,
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        threadId: undefined,
        content: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
        requesterSessionKey: "agent:main:discord:dm:U123",
        bestEffort: true,
        idempotencyKey: "announce-dm-fallback-empty",
      }),
    );
  });

  it("does not fallback when announce-agent delivered media through the message tool", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        didSendViaMessagingTool: false,
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          childSessionId: "task-123",
          announceType: "music generation task",
          taskLabel: "night-drive synthwave",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
          mediaUrls: ["/tmp/generated-night-drive.mp3"],
          replyInstruction: "Deliver the generated music through the message tool.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct",
      }),
    );
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses a direct channel fallback when announce-agent returns no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-fallback-empty",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "channel completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-fallback",
      }),
    );
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        threadId: undefined,
        content: "child completion output",
        requesterSessionKey: "agent:main:slack:channel:C123",
        bestEffort: true,
        idempotencyKey: "announce-channel-fallback-empty",
      }),
    );
  });

  it("falls back to the external requester route when completion origin is internal", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "child completion output" }],
      },
    });
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-internal-origin",
      completionDirectOrigin: {
        channel: "webchat",
      },
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "channel completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct",
      }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
        }),
      }),
    );
  });

  it("keeps direct external delivery for non-completion announces", async () => {
    const callGateway = createGatewayMock();
    await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-3",
      isActive: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-2",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
          bestEffortDeliver: true,
        }),
      }),
    );
  });
});

describe("extractThreadCompletionFallbackText", () => {
  it("prefers task completion result text", () => {
    expect(
      extractThreadCompletionFallbackText([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          announceType: "subagent task",
          taskLabel: "sample task",
          status: "ok",
          statusLabel: "completed successfully",
          result: "final child result",
          replyInstruction: "Summarize the result.",
        },
      ]),
    ).toBe("final child result");
  });

  it("falls back to task and status labels when result text is empty", () => {
    expect(
      extractThreadCompletionFallbackText([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          announceType: "subagent task",
          taskLabel: "sample task",
          status: "ok",
          statusLabel: "completed successfully",
          result: "   ",
          replyInstruction: "Summarize the result.",
        },
      ]),
    ).toBe("sample task: completed successfully");
  });

  it("falls back to the task label when result and status label are empty", () => {
    expect(
      extractThreadCompletionFallbackText([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          announceType: "subagent task",
          taskLabel: "sample task",
          status: "ok",
          statusLabel: "   ",
          result: "   ",
          replyInstruction: "Summarize the result.",
        },
      ]),
    ).toBe("sample task");
  });
});
