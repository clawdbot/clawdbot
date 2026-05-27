import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type {
  EmbeddedPiQueueFailureReason,
  EmbeddedPiQueueMessageOptions,
  EmbeddedPiQueueMessageOutcome,
} from "./pi-embedded-runner/runs.js";
import {
  testing,
  deliverSubagentAnnouncement,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import {
  callGateway as runtimeCallGateway,
  dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess,
  sendMessage as runtimeSendMessage,
} from "./subagent-announce-delivery.runtime.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";

afterEach(() => {
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
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

function createGatewaySequenceMock(
  responses: Record<string, unknown>[],
): ReturnType<typeof vi.fn> & typeof runtimeCallGateway {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return response;
  }) as unknown as ReturnType<typeof vi.fn> & typeof runtimeCallGateway;
}

function createInProcessGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async () => response) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
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

type QueueEmbeddedPiMessageWithOutcome = (
  sessionId: string,
  message: string,
  options?: EmbeddedPiQueueMessageOptions,
) => EmbeddedPiQueueMessageOutcome;

function createQueueOutcomeMock(
  queued: boolean,
): ReturnType<typeof vi.fn<QueueEmbeddedPiMessageWithOutcome>> {
  return vi.fn((sessionId: string) =>
    queued
      ? {
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
          enqueuedAtMs: 4_100,
          deliveredAtMs: 4_200,
        }
      : {
          queued: false,
          sessionId,
          reason: "not_streaming",
          gatewayHealth: "live",
        },
  );
}

function createQueueOutcomeSequenceMock(
  queuedOutcomes: (boolean | EmbeddedPiQueueFailureReason)[],
): ReturnType<typeof vi.fn<QueueEmbeddedPiMessageWithOutcome>> {
  let index = 0;
  return vi.fn((sessionId: string) => {
    const outcome = queuedOutcomes[Math.min(index, queuedOutcomes.length - 1)] ?? false;
    index += 1;
    return outcome === true
      ? {
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
        }
      : {
          queued: false,
          sessionId,
          reason: typeof outcome === "string" ? outcome : "not_streaming",
          gatewayHealth: "live",
        };
  });
}

const longChildCompletionOutput = [
  "34/34 tests pass, clean build. Now docker repro:",
  "Root cause: the requester's announce delivery accepted a prefix-only assistant payload as delivered.",
  "PR: https://github.com/openclaw/openclaw/pull/12345",
  "Verification: pnpm test src/agents/subagent-announce-delivery.test.ts passed with the regression enabled.",
].join("\n");

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function asMock(fn: unknown) {
  return fn as ReturnType<typeof vi.fn>;
}

function registerDirectTargetTestChannel(channelId: string): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channelId,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: channelId,
            capabilities: { chatTypes: ["direct", "channel"] },
          }),
          messaging: {
            inferTargetChatType: ({ to }: { to: string }) =>
              to.startsWith("channel:") || to.startsWith("thread:") ? "channel" : "direct",
          },
        },
      },
    ]),
  );
}

function mockCallArg(fn: unknown, callIndex = 0, argIndex = 0) {
  const call = asMock(fn).mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectGatewayAgentParams(
  callGateway: typeof runtimeCallGateway,
  expected: Record<string, unknown>,
) {
  const request = expectRecordFields(mockCallArg(callGateway), { method: "agent" });
  return expectRecordFields(request.params, expected);
}

function expectInProcessAgentParams(
  dispatchGatewayMethodInProcess: typeof runtimeDispatchGatewayMethodInProcess,
  expected: Record<string, unknown>,
) {
  const method = mockCallArg(dispatchGatewayMethodInProcess, 0, 0);
  expect(method).toBe("agent");
  const params = mockCallArg(dispatchGatewayMethodInProcess, 0, 1);
  return expectRecordFields(params, expected);
}

async function deliverSlackThreadAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive: boolean;
  sessionId: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  queueEmbeddedPiMessageWithOutcome?: QueueEmbeddedPiMessageWithOutcome;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  sourceTool?: string;
}) {
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId,
      isActive: params.isActive,
    }),
    getRuntimeConfig: () => ({}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedPiMessageWithOutcome
      ? { queueEmbeddedPiMessageWithOutcome: params.queueEmbeddedPiMessageWithOutcome }
      : {}),
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
    sourceTool: params.sourceTool,
  });
}

async function deliverDiscordDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  sourceTool?: string;
}) {
  const origin = {
    channel: "discord",
    to: "dm:U123",
    accountId: "acct-1",
  };
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-dm",
      isActive: false,
    }),
    getRuntimeConfig: () => ({}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
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
    sourceTool: params.sourceTool,
  });
}

async function deliverTelegramDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  isActive?: boolean;
  requesterSessionId?: string | null;
  queueEmbeddedPiMessageWithOutcome?: QueueEmbeddedPiMessageWithOutcome;
  requesterSessionKey?: string;
  sourceTool?: string;
  runtimeConfig?: Record<string, unknown>;
  origin?: {
    channel: "telegram";
    to: string;
    accountId?: string;
    threadId?: string | number;
  };
}) {
  const origin = params.origin ?? {
    channel: "telegram",
    to: "123456789",
    accountId: "bot-1",
  };
  const requesterSessionKey = params.requesterSessionKey ?? "agent:main:telegram:123456789";
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId:
        params.requesterSessionId === null
          ? undefined
          : (params.requesterSessionId ?? "requester-session-telegram"),
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedPiMessageWithOutcome
      ? { queueEmbeddedPiMessageWithOutcome: params.queueEmbeddedPiMessageWithOutcome }
      : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey,
    targetRequesterSessionKey: requesterSessionKey,
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
    sourceTool: params.sourceTool,
  });
}

async function deliverSlackChannelAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive: boolean;
  sessionId: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  requesterSessionKey?: string;
  requesterOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  completionDirectOrigin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  queueEmbeddedPiMessageWithOutcome?: QueueEmbeddedPiMessageWithOutcome;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  sourceTool?: string;
  runtimeConfig?: Record<string, unknown>;
}) {
  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
  } as const;

  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId,
      isActive: params.isActive,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedPiMessageWithOutcome
      ? { queueEmbeddedPiMessageWithOutcome: params.queueEmbeddedPiMessageWithOutcome }
      : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:slack:channel:C123",
    targetRequesterSessionKey: params.requesterSessionKey ?? "agent:main:slack:channel:C123",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: params.requesterOrigin ?? origin,
    requesterSessionOrigin: params.requesterOrigin ?? origin,
    completionDirectOrigin: params.completionDirectOrigin ?? params.requesterOrigin ?? origin,
    directOrigin: params.requesterOrigin ?? origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: params.expectsCompletionMessage,
    bestEffortDeliver: true,
    directIdempotencyKey: params.directIdempotencyKey,
    internalEvents: params.internalEvents,
    sourceTool: params.sourceTool,
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

  it("prefers requester binding when child and requester share the same channel and accountId", async () => {
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "bot-1",
      listBySession: (targetSessionKey: string) => {
        if (targetSessionKey === "agent:main:telegram:default:direct:123") {
          return [
            {
              bindingId: "telegram:bot-1:child-dm",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "telegram",
                accountId: "bot-1",
                conversationId: "direct:123",
              },
              status: "active",
              boundAt: 1,
            },
          ];
        }
        if (targetSessionKey === "agent:main:main") {
          return [
            {
              bindingId: "telegram:bot-1:parent-main",
              targetSessionKey,
              targetKind: "session",
              conversation: {
                channel: "telegram",
                accountId: "bot-1",
                conversationId: "direct:789",
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
      childSessionKey: "agent:main:telegram:default:direct:123",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:direct:789",
      },
      spawnMode: "run",
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual({
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:direct:789",
    });
  });

  it("falls back to child binding when requester has no binding", async () => {
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "bot-1",
      listBySession: (targetSessionKey: string) => {
        if (targetSessionKey === "agent:main:telegram:default:direct:123") {
          return [
            {
              bindingId: "telegram:bot-1:child-dm",
              targetSessionKey,
              targetKind: "subagent",
              conversation: {
                channel: "telegram",
                accountId: "bot-1",
                conversationId: "direct:123",
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
      childSessionKey: "agent:main:telegram:default:direct:123",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:direct:123",
      },
      spawnMode: "run",
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual({
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:direct:123",
    });
  });
});

describe("deliverSubagentAnnouncement active requester steering", () => {
  async function deliverSteeredAnnouncement(params: {
    mode?: "followup" | "collect" | "interrupt";
    queueEmbeddedPiMessageWithOutcome?: QueueEmbeddedPiMessageWithOutcome;
    requesterOrigin?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    };
  }) {
    const callGateway = createGatewayMock();
    let activityChecks = 0;
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: activityChecks++ === 0,
      }),
      queueEmbeddedPiMessageWithOutcome:
        params.queueEmbeddedPiMessageWithOutcome ?? createQueueOutcomeMock(true),
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: params.mode ?? "followup",
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

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
    });
    return callGateway;
  }

  it("steers active announces with no external route", async () => {
    const callGateway = await deliverSteeredAnnouncement({});

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("steers active announces with channel-only origins", async () => {
    const callGateway = await deliverSteeredAnnouncement({
      requesterOrigin: {
        channel: "slack",
      },
    });

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("steers active announces with internal origins", async () => {
    const callGateway = await deliverSteeredAnnouncement({
      requesterOrigin: {
        channel: "webchat",
        to: "internal:room",
        accountId: "acct-1",
        threadId: "thread-1",
      },
    });

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("steers active announces with external route fields", async () => {
    const callGateway = await deliverSteeredAnnouncement({
      requesterOrigin: {
        channel: "slack",
        to: "channel:C123",
        accountId: "acct-1",
        threadId: "171.222",
      },
    });

    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each(["followup", "collect", "interrupt"] as const)(
    "steers active requester announces even in %s mode",
    async (mode) => {
      const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
      await deliverSteeredAnnouncement({
        mode,
        queueEmbeddedPiMessageWithOutcome,
        requesterOrigin: {
          channel: "slack",
          to: "channel:C123",
          accountId: "acct-1",
        },
      });

      expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledOnce();
    },
  );

  it("preserves best-effort steering for active runtimes without transcript wait support", async () => {
    const queueEmbeddedPiMessageWithOutcome = vi
      .fn<QueueEmbeddedPiMessageWithOutcome>()
      .mockImplementationOnce((sessionId: string) => ({
        queued: false,
        sessionId,
        reason: "transcript_commit_wait_unsupported",
        gatewayHealth: "live",
      }))
      .mockImplementationOnce((sessionId: string) => ({
        queued: true,
        sessionId,
        target: "embedded_run",
        gatewayHealth: "live",
        enqueuedAtMs: 4_100,
      }));
    const callGateway = await deliverSteeredAnnouncement({
      queueEmbeddedPiMessageWithOutcome,
      requesterOrigin: {
        channel: "slack",
        to: "channel:C123",
        accountId: "acct-1",
      },
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenNthCalledWith(
      1,
      "paperclip-session",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 0,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 120_000,
      },
    );
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenNthCalledWith(
      2,
      "paperclip-session",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: 120_000,
      },
    );
  });

  it("does not report delivery when active requester steering is rejected", async () => {
    const queueEmbeddedPiMessageWithOutcome = vi.fn(async (sessionId: string) => ({
      queued: false as const,
      sessionId,
      reason: "runtime_rejected" as const,
      gatewayHealth: "live" as const,
      errorMessage: "cannot steer a compact turn",
    }));
    const callGateway = createGatewayMock();
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: true,
      }),
      queueEmbeddedPiMessageWithOutcome,
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: "steer",
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
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-rejected-steer",
    });

    expectRecordFields(result, {
      delivered: false,
      path: "none",
      phases: [{ phase: "steer-primary", delivered: false, path: "none", error: undefined }],
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("falls through to direct delivery when requester ends during awaited steering failure", async () => {
    const queueEmbeddedPiMessageWithOutcome = vi.fn(async (sessionId: string) => ({
      queued: false as const,
      sessionId,
      reason: "runtime_rejected" as const,
      gatewayHealth: "live" as const,
      errorMessage: "active session ended before queued steering message was committed",
    }));
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "child completion output" }],
      },
    });
    let activityChecks = 0;
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: activityChecks++ === 0,
      }),
      queueEmbeddedPiMessageWithOutcome,
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: "steer",
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
      requesterOrigin: slackThreadOrigin,
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-recheck-after-steer-failure",
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
      phases: [
        { phase: "steer-primary", delivered: false, path: "none", error: undefined },
        { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
      ],
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
  });
});

describe("deliverSubagentAnnouncement completion delivery", () => {
  it("uses an active requester queue as the completion handoff when message-tool delivery is not required", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-1",
      queueEmbeddedPiMessageWithOutcome,
    });

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 4_200,
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session-1",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 120_000,
      },
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not also direct-run a queued active completion", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-harness-task",
      queueEmbeddedPiMessageWithOutcome,
      sourceTool: "agent_harness_task",
    });

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 4_200,
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps direct external delivery for dormant completion requesters", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(false);
    await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-2",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-1b",
      queueEmbeddedPiMessageWithOutcome,
    });

    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
    expect(queueEmbeddedPiMessageWithOutcome).not.toHaveBeenCalled();
  });

  it("directly delivers direct-message subagent text when the announce agent returns no visible output", async () => {
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
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "direct completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        content: "child completion output",
        idempotencyKey: "announce-dm-fallback-empty:text-direct",
      }),
    );
  });

  it("does not directly deliver failed subagent placeholder output", async () => {
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
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "direct completion smoke",
          status: "error",
          statusLabel: "failed: all models failed",
          result: "(no output)",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers unprefixed direct targets recognized by the channel grammar", async () => {
    registerDirectTargetTestChannel("qa-channel");
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-qa",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-qa-fallback-empty",
      requesterSessionKey: "agent:qa:subagent-direct-fallback:1234",
      requesterOrigin: {
        channel: "qa-channel",
        to: "qa-operator",
        accountId: "default",
      },
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "qa direct completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "qa-channel",
        accountId: "default",
        to: "qa-operator",
        content: "child completion output",
        idempotencyKey: "announce-qa-fallback-empty:text-direct",
      }),
    );
  });

  it("does not raw-send channel completions just because the requester key is direct", async () => {
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
      directIdempotencyKey: "announce-channel-direct-key-empty",
      requesterSessionKey: "agent:main:discord:dm:U123",
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers direct-message subagent text when the announce agent returns incomplete", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error(
        "FailoverError: mock-openai/gpt-5.5 ended with an incomplete terminal response: code=incomplete_result",
      );
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "direct completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        content: "child completion output",
        idempotencyKey: "announce-dm-fallback-empty:text-direct",
      }),
    );
  });

  it("uses in-process agent dispatch for dormant completion requesters", async () => {
    const callGateway = createGatewayMock();
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [{ text: "requester voice completion" }],
      },
    });
    testing.setDepsForTest({
      callGateway,
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session-local",
        isActive: false,
      }),
      getRuntimeConfig: () => ({}) as never,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterOrigin: slackThreadOrigin,
      requesterSessionOrigin: slackThreadOrigin,
      completionDirectOrigin: slackThreadOrigin,
      directOrigin: slackThreadOrigin,
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-dispatch",
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).not.toHaveBeenCalled();
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
    expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 2)).toMatchObject({
      expectFinal: true,
      forceSyntheticClient: true,
      timeoutMs: 120_000,
    });
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    const params = expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
    expect(Array.isArray(params.internalEvents)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps requester-agent output primary even when it is a child-result prefix", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "34/34 tests pass, clean build. Now docker repro:" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-prefix",
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
          result: longChildCompletionOutput,
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps word-boundary requester-agent prefixes on the mediated path", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "34/34 tests pass, clean build. Now docker repro" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-word-prefix",
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
          result: longChildCompletionOutput,
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps mid-word requester-agent prefixes on the mediated path", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "34/34 tests pass, clean build. Now dock" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-midword-prefix",
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
          result: longChildCompletionOutput,
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports requester-agent delivery failure even when output stayed visible", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "Tests passed and the PR is ready for review." }],
        deliveryStatus: {
          status: "failed",
          errorMessage: "Slack send failed: channel not found",
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-delivery-status-failed",
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "Slack send failed: channel not found",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not raw-send grouped child results when requester-agent output is empty", async () => {
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
      directIdempotencyKey: "announce-thread-fallback-grouped-results",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:first",
          childSessionId: "child-session-1",
          announceType: "subagent task",
          taskLabel: "first task",
          status: "ok",
          statusLabel: "completed successfully",
          result: "first child result",
          replyInstruction: "Summarize the result.",
        },
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:second",
          childSessionId: "child-session-2",
          announceType: "subagent task",
          taskLabel: "second task",
          status: "ok",
          statusLabel: "completed successfully",
          result: "second child result",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats stale thread subagent completions as delivered after parent handoff", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "requester-session-4",
      isActive: true,
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenNthCalledWith(
      1,
      "requester-session-4",
      "child done",
      {
        debounceMs: 500,
        deliveryTimeoutMs: 120_000,
        steeringMode: "all",
        waitForTranscriptCommit: true,
      },
    );
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenNthCalledWith(
      2,
      "requester-session-4",
      "child done",
      {
        debounceMs: 500,
        deliveryTimeoutMs: 120_000,
        steeringMode: "all",
      },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps concise requester rewrites primary even when child output is long", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "Tests passed and the PR is ready for review." }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-rewrite-primary",
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
          result: longChildCompletionOutput,
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps copied complete-sentence requester summaries primary", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "34/34 tests pass, clean build." }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-copied-summary-primary",
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
          result: longChildCompletionOutput,
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports failure instead of raw-sending child output when announce-agent delivery fails", async () => {
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "UNAVAILABLE: gateway lost final output",
    });
    expect(callGateway).toHaveBeenCalledTimes(4);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports failure for Telegram DMs when announce-agent delivery fails", async () => {
    const callGateway = createGatewayMock({
      result: {
        deliveryStatus: {
          status: "failed",
          errorMessage: "requester wake failed",
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome: createQueueOutcomeMock(false),
      requesterSessionId: null,
      requesterSessionKey: "agent:main:telegram:direct:123456789",
      origin: {
        channel: "telegram",
        to: "direct:123456789",
        accountId: "bot-1",
      },
      runtimeConfig: {
        agents: {
          defaults: {
            subagents: {
              announceTimeoutMs: 10,
            },
          },
        },
      },
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "requester wake failed",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to requester-agent handoff when an active Telegram requester cannot be woken", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "child completion output" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      isActive: true,
      queueEmbeddedPiMessageWithOutcome,
      runtimeConfig: {
        agents: {
          defaults: {
            subagents: {
              announceTimeoutMs: 10,
            },
          },
        },
      },
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
      phases: [
        {
          phase: "direct-primary",
          delivered: true,
          path: "direct",
          error: undefined,
        },
      ],
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session-telegram",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 10,
      },
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses steer fallback when a completion handoff has no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const queueEmbeddedPiMessageWithOutcome = vi
      .fn<QueueEmbeddedPiMessageWithOutcome>()
      .mockImplementationOnce((sessionId: string) => ({
        queued: false,
        sessionId,
        reason: "not_streaming",
        gatewayHealth: "live",
      }))
      .mockImplementationOnce((sessionId: string) => ({
        queued: true,
        sessionId,
        target: "embedded_run",
        gatewayHealth: "live",
      }));
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sessionId: "requester-session-channel",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-empty-direct-steer-fallback",
      queueEmbeddedPiMessageWithOutcome,
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
      phases: [
        {
          phase: "direct-primary",
          delivered: true,
          path: "direct",
          error: undefined,
        },
      ],
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("does not fail stale thread subagent completions only because the parent stayed private", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "requester-session-4",
      isActive: true,
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers generated media DMs when announce-agent returns no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        content: "The generated music is ready.",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        idempotencyKey: "announce-dm-fallback-empty:generated-media-direct",
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
      sourceTool: "music_generate",
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not fallback when message-tool evidence already contains generated media", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
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
          replyInstruction:
            "Tell the user the music is ready and send it through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("requires generated media completion DMs to use the message tool", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
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
          replyInstruction:
            "Tell the user the music is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stringifies Telegram topic ids for generated video completion handoff", async () => {
    const callGateway = createGatewayMock({
      payloads: [],
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/generated-corgi.mp4"],
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      requesterSessionKey: "agent:main:telegram:group:-1003970070733:topic:1",
      origin: {
        channel: "telegram",
        to: "telegram:-1003970070733",
        accountId: "bot-1",
        threadId: 1,
      },
      sourceTool: "video_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "video_generation",
          childSessionKey: "video_generate:task-123",
          childSessionId: "task-123",
          announceType: "video generation task",
          taskLabel: "anime corgi skateboard",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 video.\nMEDIA:/tmp/generated-corgi.mp4",
          mediaUrls: ["/tmp/generated-corgi.mp4"],
          replyInstruction: "Deliver the generated video through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:-1003970070733",
      threadId: "1",
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("requires generated image completion DMs to use the message tool", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            text: "The image is ready.",
            mediaUrls: ["/tmp/generated-robot.png"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "image_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: "image_generate:task-123",
          childSessionId: "task-123",
          announceType: "image generation task",
          taskLabel: "small watercolor robot",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 image.\nMEDIA:/tmp/generated-robot.png",
          mediaUrls: ["/tmp/generated-robot.png"],
          replyInstruction:
            "Tell the user the image is ready and send it through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("accepts failed generated media completion notices without requiring message-tool delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            text: "Music generation failed: provider failed.",
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          childSessionId: "task-123",
          announceType: "music generation task",
          taskLabel: "night-drive synthwave",
          status: "error",
          statusLabel: "failed",
          result: "provider failed",
          replyInstruction: "Deliver the failure through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers generated media when the announce agent replies text-only", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The track is ready.",
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
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
          result: "Generated 1 track.",
          attachments: [
            {
              type: "audio",
              path: "/tmp/generated-night-drive.mp3",
              mimeType: "audio/mpeg",
              name: "generated-night-drive.mp3",
            },
          ],
          replyInstruction: "Deliver the generated music.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        content: "The generated music is ready.",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        idempotencyKey: "announce-dm-fallback-empty:generated-media-direct",
      }),
    );
  });

  it("allows visible direct delivery for media generation failure summaries without generated media", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "Music generation failed. Provider timed out." }],
      },
    });
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sourceTool: "music_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "music_generation",
          childSessionKey: "music_generate:task-123",
          childSessionId: "task-123",
          announceType: "music generation task",
          taskLabel: "night-drive synthwave",
          status: "error",
          statusLabel: "failed",
          result: "All music generation models failed.",
          replyInstruction: "Tell the user music generation failed.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
    });
  });

  it("directly delivers generated media group completions that miss required message-tool delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The track is ready.",
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-message-tool",
      sourceTool: "music_generate",
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
          replyInstruction:
            "Tell the user the music is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: undefined,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated music is ready.",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        idempotencyKey: "announce-channel-media-message-tool:generated-media-direct",
      }),
    );
  });

  it("directly delivers payload-only generated media when message tool sent text only", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:C123",
            text: "The track is ready.",
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-text-only-message-tool",
      sourceTool: "music_generate",
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
          replyInstruction:
            "Tell the user the music is ready and send it through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated music is ready.",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        idempotencyKey: "announce-channel-media-text-only-message-tool:generated-media-direct",
      }),
    );
  });

  it("directly delivers only missing generated media after partial message-tool delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:C123",
            text: "The first image is ready.",
            mediaUrls: ["/tmp/generated-robot-1.png"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-partial-message-tool",
      sourceTool: "image_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: "image_generate:task-123",
          childSessionId: "task-123",
          announceType: "image generation task",
          taskLabel: "two proof images",
          status: "ok",
          statusLabel: "completed successfully",
          result:
            "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
          mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
          replyInstruction:
            "Tell the user the images are ready and send them through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated image is ready.",
        mediaUrls: ["/tmp/generated-robot-2.png"],
        idempotencyKey: "announce-channel-media-partial-message-tool:generated-media-direct",
      }),
    );
  });

  it("keeps generated media completions on the active requester session path", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-active-direct",
      sourceTool: "video_generate",
      queueEmbeddedPiMessageWithOutcome,
      internalEvents: [
        {
          type: "task_completion",
          source: "video_generation",
          childSessionKey: "video_generate:task-123",
          childSessionId: "task-123",
          announceType: "video generation task",
          taskLabel: "corgi proof video",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 video.\nMEDIA:/tmp/generated-corgi.mp4",
          mediaUrls: ["/tmp/generated-corgi.mp4"],
          replyInstruction:
            "Tell the user the video is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 4_200,
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session-channel",
      "child done",
      {
        steeringMode: "all",
        sourceReplyDeliveryMode: "message_tool_only",
        debounceMs: 500,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 120_000,
      },
    );
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers missing generated media after active requester wake failure", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:C123",
            text: "The first image is ready.",
            mediaUrls: ["/tmp/generated-robot-1.png"],
          },
        ],
      },
    });
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "requester-session-channel",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-active-wake-failed",
      sourceTool: "image_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: "image_generate:task-123",
          childSessionId: "task-123",
          announceType: "image generation task",
          taskLabel: "two proof images",
          status: "ok",
          statusLabel: "completed successfully",
          result:
            "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
          mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
          replyInstruction:
            "Tell the user the images are ready and send them through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated image is ready.",
        mediaUrls: ["/tmp/generated-robot-2.png"],
        idempotencyKey: "announce-channel-media-active-wake-failed:generated-media-direct",
      }),
    );
  });

  it("directly delivers stale isolated cron run media completions", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      isActive: false,
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-stale-cron-media",
      sourceTool: "image_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: "image_generate:task-123",
          childSessionId: "task-123",
          announceType: "image generation task",
          taskLabel: "daily media",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 image.\nMEDIA:/tmp/generated-daily.png",
          mediaUrls: ["/tmp/generated-daily.png"],
          replyInstruction: "Deliver the generated image through the requester run.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(queueEmbeddedPiMessageWithOutcome).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated image is ready.",
        mediaUrls: ["/tmp/generated-daily.png"],
        idempotencyKey: "announce-stale-cron-media:generated-media-direct",
      }),
    );
  });

  it("no-ops stale isolated cron run text completions", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      isActive: false,
      requesterSessionKey: "agent:main:cron:daily-text:run:run-123",
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-stale-cron-text",
      sourceTool: "subagent_announce",
    });

    expectRecordFields(result, {
      delivered: true,
      path: "none",
      phases: [{ phase: "direct-primary", delivered: true, path: "none", error: undefined }],
    });
    expect(queueEmbeddedPiMessageWithOutcome).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers stale isolated cron run media failure completions", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "Image generation failed. Provider timed out." }],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      isActive: false,
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-stale-cron-media-failure",
      sourceTool: "image_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: "image_generate:task-123",
          childSessionId: "task-123",
          announceType: "image generation task",
          taskLabel: "daily media",
          status: "error",
          statusLabel: "failed",
          result: "Provider timed out.",
          replyInstruction: "Tell the user image generation failed.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(queueEmbeddedPiMessageWithOutcome).not.toHaveBeenCalled();
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "legacy Discord channel",
      requesterSessionKey: "agent:main:discord:guild-123:channel-456",
      origin: { channel: "discord", to: "channel:456", accountId: "acct-1" },
    },
    {
      name: "legacy WhatsApp group",
      requesterSessionKey: "agent:main:whatsapp:123@g.us",
      origin: { channel: "whatsapp", to: "123@g.us", accountId: "acct-1" },
    },
  ])(
    "requires message-tool delivery for generated media completions in $name sessions",
    async ({ requesterSessionKey, origin }) => {
      const callGateway = createGatewayMock({
        result: {
          payloads: [
            {
              text: "The track is ready.",
            },
          ],
        },
      });
      const sendMessage = createSendMessageMock();
      const result = await deliverSlackChannelAnnouncement({
        callGateway,
        sendMessage,
        sessionId: "requester-session-legacy-group",
        isActive: false,
        expectsCompletionMessage: true,
        directIdempotencyKey: `announce-legacy-media-message-tool-${origin.channel}`,
        requesterSessionKey,
        requesterOrigin: origin,
        sourceTool: "music_generate",
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
            replyInstruction:
              "Tell the user the music is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
          },
        ],
      });

      expectRecordFields(result, {
        delivered: true,
        path: "direct",
      });
      expectGatewayAgentParams(callGateway, {
        deliver: false,
        channel: origin.channel,
        accountId: "acct-1",
        to: origin.to,
        threadId: undefined,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: origin.channel,
          accountId: "acct-1",
          to: origin.to,
          content: "The generated music is ready.",
          mediaUrls: ["/tmp/generated-night-drive.mp3"],
          idempotencyKey: `announce-legacy-media-message-tool-${origin.channel}:generated-media-direct`,
        }),
      );
    },
  );

  it("does not fallback for generated media group completions when message tool evidence exists", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        didSendViaMessagingTool: false,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:C123",
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-message-tool-evidence",
      sourceTool: "music_generate",
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves pending announce delivery without direct generated media fallback", async () => {
    const callGateway = createGatewayMock({
      runId: "video_generate:task-123:ok",
      status: "accepted",
      acceptedAt: Date.now(),
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-pending",
      sourceTool: "video_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "video_generation",
          childSessionKey: "video_generate:task-123",
          childSessionId: "task-123",
          announceType: "video generation task",
          taskLabel: "lobster trailer",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 video.\nMEDIA:/tmp/lobster-trailer.mp4",
          mediaUrls: ["/tmp/lobster-trailer.mp4"],
          replyInstruction: "Deliver the generated video through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not race pending announce delivery with direct generated media fallback", async () => {
    const callGateway = createGatewayMock({
      runId: "video_generate:task-123:ok",
      status: "accepted",
      acceptedAt: Date.now(),
    });
    const sendMessage = vi.fn(async () => {
      throw new Error("temporary channel upload failure");
    }) as unknown as typeof runtimeSendMessage;
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-media-pending-fallback-fails",
      sourceTool: "video_generate",
      internalEvents: [
        {
          type: "task_completion",
          source: "video_generation",
          childSessionKey: "video_generate:task-123",
          childSessionId: "task-123",
          announceType: "video generation task",
          taskLabel: "lobster trailer",
          status: "ok",
          statusLabel: "completed successfully",
          result: "Generated 1 video.\nMEDIA:/tmp/lobster-trailer.mp4",
          mediaUrls: ["/tmp/lobster-trailer.mp4"],
          replyInstruction: "Deliver the generated video through the message tool.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not fail stale channel subagent completions only because the parent stayed private", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedPiMessageWithOutcome,
      sessionId: "requester-session-channel",
      isActive: true,
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps configured channel subagent completions on parent message-tool handoff", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "The subagent is done." }],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The subagent is done."],
      },
    });
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-subagent-message-tool",
      sourceTool: "subagent_announce",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      queueEmbeddedPiMessageWithOutcome,
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: undefined,
      sourceReplyDeliveryMode: "message_tool_only",
    });
  });

  it("fails configured channel subagent completions when parent skips required message tool", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "The subagent is done." }],
      },
    });
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sessionId: "requester-session-channel",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-channel-subagent-message-tool-missing",
      sourceTool: "subagent_announce",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      queueEmbeddedPiMessageWithOutcome,
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not use the message tool for message-tool-only delivery",
    });
  });

  it("delivers Telegram forum-topic subagent completions through the normal parent handoff", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "The delegated task is complete." }],
      },
    });

    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      requesterSessionKey: "agent:main:telegram:group:-1003871627242:topic:6823",
      origin: {
        channel: "telegram",
        to: "telegram:-1003871627242",
        accountId: "bot-1",
        threadId: 6823,
      },
      sourceTool: "subagent_announce",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:codex:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "telegram forum completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "delegated task output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:-1003871627242",
      threadId: "6823",
    });
  });

  it("keeps automatic final delivery for direct subagent completions", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "The subagent is done." }],
      },
    });
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sourceTool: "subagent_announce",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "direct completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
    });
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
    });
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

    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
  });
});
