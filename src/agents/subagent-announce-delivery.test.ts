import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type {
  EmbeddedPiQueueMessageOptions,
  EmbeddedPiQueueMessageOutcome,
} from "./pi-embedded-runner/runs.js";
import {
  __testing,
  deliverSubagentAnnouncement,
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
        }
      : {
          queued: false,
          sessionId,
          reason: "not_streaming",
          gatewayHealth: "live",
        },
  );
}

const longChildCompletionOutput = [
  "34/34 tests pass, clean build. Now docker repro:",
  "Root cause: the requester's announce delivery accepted a prefix-only assistant payload as delivered.",
  "PR: https://github.com/openclaw/openclaw/pull/12345",
  "Verification: pnpm test src/agents/subagent-announce-delivery.test.ts passed with the regression enabled.",
].join("\n");

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toBeDefined();
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function asMock(fn: unknown) {
  return fn as ReturnType<typeof vi.fn>;
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
  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId,
      isActive: params.isActive,
    }),
    getRuntimeConfig: () => ({}) as never,
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
  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-dm",
      isActive: false,
    }),
    getRuntimeConfig: () => ({}) as never,
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
  queueEmbeddedPiMessageWithOutcome?: QueueEmbeddedPiMessageWithOutcome;
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
    ...(params.queueEmbeddedPiMessageWithOutcome
      ? { queueEmbeddedPiMessageWithOutcome: params.queueEmbeddedPiMessageWithOutcome }
      : {}),
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

    expectRecordFields(result, {
      delivered: true,
      path: "queued",
    });
    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(1));
    return callGateway;
  }

  it("keeps queued announces with no external route session-only", async () => {
    const callGateway = await deliverQueuedAnnouncement({});

    expectGatewayAgentParams(callGateway, {
      sessionKey: "agent:eng:paperclip:issue:123",
      deliver: false,
      channel: undefined,
      accountId: undefined,
      to: undefined,
      threadId: undefined,
    });
  });

  it("keeps queued announces with channel-only origins session-only", async () => {
    const callGateway = await deliverQueuedAnnouncement({
      requesterOrigin: {
        channel: "slack",
      },
    });

    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: undefined,
      to: undefined,
    });
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

    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: undefined,
      accountId: undefined,
      to: undefined,
      threadId: undefined,
    });
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

    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
    });
  });
});

describe("deliverSubagentAnnouncement completion delivery", () => {
  it("keeps completion announces session-internal while preserving route context for active requesters", async () => {
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
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session-1",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
      },
    );
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

    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
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
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
    });
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
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports failure for Telegram DMs when announce-agent delivery fails", async () => {
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "UNAVAILABLE: requester wake failed",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queues when an active Telegram requester cannot be woken directly", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedPiMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      isActive: true,
      queueEmbeddedPiMessageWithOutcome,
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
      path: "queued",
      phases: [
        {
          phase: "direct-primary",
          delivered: false,
          path: "direct",
          error:
            "active requester session could not be woken: queue_message_failed reason=not_streaming sessionId=requester-session-telegram gatewayHealth=live",
        },
        {
          phase: "queue-fallback",
          delivered: true,
          path: "queued",
          error: undefined,
        },
      ],
    });
    expect(queueEmbeddedPiMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session-telegram",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
      },
    );
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports failure when announce-agent returns no visible output", async () => {
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
    });
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports failure for completion DMs when announce-agent returns no visible output", async () => {
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
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

    expectRecordFields(result, {
      delivered: true,
      path: "direct",
    });
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers generated media completions through the announce agent in automatic DMs", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
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
      deliver: true,
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
      threadId: undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports generated media group completions that miss required message-tool delivery", async () => {
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
      delivered: false,
      path: "direct",
      error: "completion agent did not deliver through the message tool",
    });
    expectGatewayAgentParams(callGateway, {
      deliver: false,
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
        delivered: false,
        path: "direct",
        error: "completion agent did not deliver through the message tool",
      });
      expectGatewayAgentParams(callGateway, {
        deliver: false,
        channel: origin.channel,
        accountId: "acct-1",
        to: origin.to,
        threadId: undefined,
      });
      expect(sendMessage).not.toHaveBeenCalled();
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

  it("does not fallback while generated media announce-agent run is still pending", async () => {
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
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("reports channel completion failure when announce-agent returns no visible output", async () => {
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

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
    });
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
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
