// Subagent announce delivery tests cover the last-mile routing used when child
// runs report progress or completion back to the requester session.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { OutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import {
  testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "./embedded-agent-runner/runs.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  callGateway as runtimeCallGateway,
  dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess,
  sendMessage as runtimeSendMessage,
} from "./subagent-announce-delivery.runtime.js";
import {
  testing,
  deliverSubagentAnnouncement,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.test-support.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  createTaskCompletionEvent,
  expectDeliveryPath,
  expectRecordFields,
  imageCompletionEvents,
  mockCallArg,
  musicCompletionEvents,
  taskCompletionEvents,
} from "./subagent-test-fixtures.test-helpers.js";

const sessionDeliveryQueueMocks = vi.hoisted(() => ({
  ackSessionDelivery: vi.fn(async () => {}),
  enqueueClaimedSessionDelivery: vi.fn(async () => ({
    id: "session-delivery-media",
    claimed: true,
    status: "pending" as "pending" | "failed" | "completed" | "unknown",
  })),
  moveSessionDeliveryToFailed: vi.fn(async () => {}),
  releaseSessionDeliveryClaim: vi.fn(async () => {}),
  scheduleSessionDelivery: vi.fn(async () => true),
}));

const generatedMediaWakeMocks = vi.hoisted(() => ({
  wakeSessionForGeneratedMediaDirectDelivery: vi.fn(),
}));

vi.mock("./generated-media-direct-delivery-wake.js", () => generatedMediaWakeMocks);

vi.mock("../infra/session-delivery-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/session-delivery-queue.js")>()),
  ackSessionDelivery: sessionDeliveryQueueMocks.ackSessionDelivery,
  enqueueClaimedSessionDelivery: sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery,
  moveSessionDeliveryToFailed: sessionDeliveryQueueMocks.moveSessionDeliveryToFailed,
  releaseSessionDeliveryClaim: sessionDeliveryQueueMocks.releaseSessionDeliveryClaim,
}));

vi.mock("../infra/session-delivery-queue-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/session-delivery-queue-runtime.js")>()),
  scheduleSessionDelivery: sessionDeliveryQueueMocks.scheduleSessionDelivery,
}));

type EmbeddedAgentQueueFailureReason = Extract<
  EmbeddedAgentQueueMessageOutcome,
  { queued: false }
>["reason"];

afterEach(() => {
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
  sessionDeliveryQueueMocks.ackSessionDelivery.mockClear();
  sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockClear();
  sessionDeliveryQueueMocks.moveSessionDeliveryToFailed.mockClear();
  sessionDeliveryQueueMocks.releaseSessionDeliveryClaim.mockClear();
  sessionDeliveryQueueMocks.scheduleSessionDelivery.mockClear();
  generatedMediaWakeMocks.wakeSessionForGeneratedMediaDirectDelivery.mockClear();
});

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

function createGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async (opts: Parameters<typeof runtimeCallGateway>[0]) => {
    opts.onAccepted?.({ status: "accepted" });
    return response;
  }) as unknown as typeof runtimeCallGateway;
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

function readyCronContinuationEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now(),
    cronRunContinuation: {
      lifecycleRevision: "revision-1",
      phase: "ready",
      basePersisted: true,
    },
  };
}

type QueueEmbeddedAgentMessageWithOutcome = (
  sessionId: string,
  message: string,
  options?: EmbeddedAgentQueueMessageOptions,
) => EmbeddedAgentQueueMessageOutcome;

function createQueueOutcomeMock(
  queued: boolean,
): ReturnType<typeof vi.fn<QueueEmbeddedAgentMessageWithOutcome>> {
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
  queuedOutcomes: (boolean | EmbeddedAgentQueueFailureReason)[],
): ReturnType<typeof vi.fn<QueueEmbeddedAgentMessageWithOutcome>> {
  // Sequence mocks model retry paths where the embedded run can become
  // unavailable between announce attempts.
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

function registerTestSessionBindings(
  channel: string,
  accountId: string,
  bindings: ReadonlyArray<{
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    conversationId: string;
  }>,
): void {
  registerSessionBindingAdapter({
    channel,
    accountId,
    listBySession: (targetSessionKey) =>
      bindings
        .filter((binding) => binding.targetSessionKey === targetSessionKey)
        .map((binding) => ({
          bindingId: `${channel}:${accountId}:${binding.conversationId}`,
          targetSessionKey,
          targetKind: binding.targetKind,
          conversation: { channel, accountId, conversationId: binding.conversationId },
          status: "active" as const,
          boundAt: 1,
        })),
    resolveByConversation: () => null,
  });
}

function expectGatewayAgentParams(
  callGateway: typeof runtimeCallGateway,
  expected: Record<string, unknown>,
) {
  const request = expectRecordFields(mockCallArg(callGateway), { method: "agent" });
  return expectRecordFields(request.params, expected);
}

function expectDiscordDirectAgentParams(
  callGateway: typeof runtimeCallGateway,
  expected: Record<string, unknown> = {},
) {
  return expectGatewayAgentParams(callGateway, {
    deliver: true,
    channel: "discord",
    accountId: "acct-1",
    to: "dm:U123",
    threadId: undefined,
    ...expected,
  });
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
  isActive?: boolean;
  sessionId?: string;
  expectsCompletionMessage?: boolean;
  directIdempotencyKey: string;
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  sourceTool?: string;
  requesterAbandoned?: boolean;
}) {
  // Slack thread delivery exercises all origins because direct, session, and
  // completion routing can differ after a child run outlives its requester.
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId ?? "requester-session-4",
      isActive: params.isActive === true,
    }),
    isRequesterSessionAbandoned: () => params.requesterAbandoned === true,
    getRuntimeConfig: () => ({}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
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
    expectsCompletionMessage: params.expectsCompletionMessage !== false,
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
  isActive?: boolean;
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  sourceTool?: string;
  signal?: AbortSignal;
  durableGeneratedMediaHandoff?: boolean;
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
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => ({}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
      : {}),
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
    signal: params.signal,
    durableGeneratedMediaHandoff: params.durableGeneratedMediaHandoff,
  });
}

async function deliverTelegramDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  isActive?: boolean;
  requesterSessionId?: string | null;
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  requesterSessionKey?: string;
  sourceTool?: string;
  runtimeConfig?: Record<string, unknown>;
  requesterAbandoned?: boolean;
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
    isRequesterSessionAbandoned: () => params.requesterAbandoned === true,
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
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
  dispatchGatewayMethodInProcess?: typeof runtimeDispatchGatewayMethodInProcess;
  isActive?: boolean;
  sessionId?: string;
  expectsCompletionMessage?: boolean;
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
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  runtimeConfig?: Record<string, unknown>;
  requesterSessionEntry?: SessionEntry;
  requesterSessionEntries?: SessionEntry[];
  resolveRequesterSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  durableGeneratedMediaHandoff?: boolean;
}) {
  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
  } as const;
  let requesterEntryReadIndex = 0;
  const requesterSessionEntries = params.requesterSessionEntries ?? [];
  const hasRequesterSessionEntryResolver =
    params.requesterSessionEntry !== undefined ||
    requesterSessionEntries.length > 0 ||
    params.resolveRequesterSessionEntry !== undefined;

  testing.setDepsForTest({
    callGateway: params.callGateway,
    ...(params.dispatchGatewayMethodInProcess
      ? { dispatchGatewayMethodInProcess: params.dispatchGatewayMethodInProcess }
      : {}),
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId ?? "requester-session-channel",
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    ...(hasRequesterSessionEntryResolver
      ? {
          loadRequesterSessionEntry: (sessionKey: string) => ({
            cfg: (params.runtimeConfig ?? {}) as never,
            entry:
              params.requesterSessionEntry ??
              params.resolveRequesterSessionEntry?.(sessionKey) ??
              requesterSessionEntries[
                Math.min(requesterEntryReadIndex++, requesterSessionEntries.length - 1)
              ],
            canonicalKey: sessionKey,
          }),
        }
      : {}),
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
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
    expectsCompletionMessage: params.expectsCompletionMessage !== false,
    bestEffortDeliver: true,
    directIdempotencyKey: params.directIdempotencyKey,
    internalEvents: params.internalEvents,
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool,
    durableGeneratedMediaHandoff: params.durableGeneratedMediaHandoff,
  });
}

describe("resolveAnnounceOrigin threaded route targets", () => {
  it.each([
    {
      name: "does not inherit a target or thread from another account on the same channel",
      stored: {
        lastChannel: "telegram",
        lastTo: "peer-b",
        lastAccountId: "bot-b",
        lastThreadId: 99,
      },
      requester: { channel: "telegram", accountId: "bot-a" },
      expected: { channel: "telegram", to: undefined, accountId: "bot-a" },
    },
    {
      name: "preserves stored thread ids when requester origin omits one for the same chat",
      stored: {
        lastChannel: "topicchat",
        lastTo: "topicchat:room-a:topic:99",
        lastThreadId: 99,
      },
      requester: { channel: "topicchat", to: "topicchat:room-a" },
      expected: { channel: "topicchat", to: "topicchat:room-a", threadId: 99 },
    },
    {
      name: "preserves stored thread ids for group-prefixed requester targets",
      stored: {
        lastChannel: "topicchat",
        lastTo: "topicchat:room-a:topic:99",
        lastThreadId: 99,
      },
      requester: { channel: "topicchat", to: "group:room-a" },
      expected: { channel: "topicchat", to: "group:room-a", threadId: 99 },
    },
    {
      name: "still strips stale thread ids when the stored route points at a different chat",
      stored: {
        lastChannel: "topicchat",
        lastTo: "topicchat:room-b:topic:99",
        lastThreadId: 99,
      },
      requester: { channel: "topicchat", to: "topicchat:room-a" },
      expected: { channel: "topicchat", to: "topicchat:room-a" },
    },
  ])("$name", ({ stored, requester, expected }) => {
    expect(
      resolveAnnounceOrigin(
        normalizeLegacySessionEntryDelivery(stored as unknown as SessionEntry),
        requester,
      ),
    ).toEqual(expected);
  });
});

describe("resolveSubagentCompletionOrigin", () => {
  it.each([
    {
      name: "resolves bound completion delivery from the requester session, not the child session",
      bindings: [
        {
          channel: "discord",
          accountId: "bot-alpha",
          targetSessionKey: "agent:worker:subagent:child",
          targetKind: "subagent" as const,
          conversationId: "child-window",
        },
        {
          channel: "discord",
          accountId: "acct-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId: "parent-main",
        },
      ],
      childSessionKey: "agent:worker:subagent:child",
      requesterOrigin: {
        channel: "discord",
        accountId: "acct-1",
        to: "channel:parent-main",
      },
      expected: { channel: "discord", accountId: "acct-1", to: "channel:parent-main" },
      spawnMode: "session" as const,
    },
    {
      name: "prefers requester binding when child and requester share the same channel and accountId",
      bindings: [
        {
          channel: "telegram",
          accountId: "bot-1",
          targetSessionKey: "agent:main:telegram:default:direct:123",
          targetKind: "subagent" as const,
          conversationId: "direct:123",
        },
        {
          channel: "telegram",
          accountId: "bot-1",
          targetSessionKey: "agent:main:main",
          targetKind: "session" as const,
          conversationId: "direct:789",
        },
      ],
      childSessionKey: "agent:main:telegram:default:direct:123",
      requesterOrigin: {
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:direct:789",
      },
      expected: { channel: "telegram", accountId: "bot-1", to: "telegram:direct:789" },
      spawnMode: "run" as const,
    },
    {
      name: "falls back to child binding when requester has no binding",
      bindings: [
        {
          channel: "telegram",
          accountId: "bot-1",
          targetSessionKey: "agent:main:telegram:default:direct:123",
          targetKind: "subagent" as const,
          conversationId: "direct:123",
        },
      ],
      childSessionKey: "agent:main:telegram:default:direct:123",
      requesterOrigin: {
        channel: "telegram",
        accountId: "bot-1",
        to: "telegram:direct:123",
      },
      expected: { channel: "telegram", accountId: "bot-1", to: "telegram:direct:123" },
      spawnMode: "run" as const,
    },
  ])("$name", async ({ bindings, childSessionKey, requesterOrigin, expected, spawnMode }) => {
    const bindingGroups = new Map<string, (typeof bindings)[number][]>();
    for (const binding of bindings) {
      const key = `${binding.channel}\0${binding.accountId}`;
      const group = bindingGroups.get(key) ?? [];
      group.push(binding);
      bindingGroups.set(key, group);
    }
    for (const group of bindingGroups.values()) {
      const binding = group[0];
      if (binding) {
        registerTestSessionBindings(binding.channel, binding.accountId, group);
      }
    }

    const origin = await resolveSubagentCompletionOrigin({
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterOrigin,
      spawnMode,
      expectsCompletionMessage: true,
    });

    expect(origin).toEqual(expected);
  });
});

describe("deliverSubagentAnnouncement active requester steering", () => {
  async function deliverSteeredAnnouncement(params: {
    mode?: "followup" | "collect" | "interrupt";
    announceTimeoutMs?: number;
    queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
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
      queueEmbeddedAgentMessageWithOutcome:
        params.queueEmbeddedAgentMessageWithOutcome ?? createQueueOutcomeMock(true),
      getRuntimeConfig: () =>
        ({
          ...(params.announceTimeoutMs !== undefined
            ? {
                agents: {
                  defaults: {
                    subagents: {
                      announceTimeoutMs: params.announceTimeoutMs,
                    },
                  },
                },
              }
            : {}),
          messages: {
            queue: {
              mode: params.mode ?? "followup",
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

    expectDeliveryPath(result, "steered");
    return callGateway;
  }

  it.each([
    {
      name: "steers active announces with no external route",
      requesterOrigin: undefined,
    },
    {
      name: "steers active announces with channel-only origins",
      requesterOrigin: { channel: "slack" },
    },
    {
      name: "steers active announces with internal origins",
      requesterOrigin: {
        channel: "webchat",
        to: "internal:room",
        accountId: "acct-1",
        threadId: "thread-1",
      },
    },
    {
      name: "steers active announces with external route fields",
      requesterOrigin: {
        channel: "slack",
        to: "channel:C123",
        accountId: "acct-1",
        threadId: "171.222",
      },
    },
  ])("$name", async ({ requesterOrigin }) => {
    const callGateway = await deliverSteeredAnnouncement({ requesterOrigin });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each(["followup", "collect", "interrupt"] as const)(
    "steers active requester announces even in %s mode",
    async (mode) => {
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
      await deliverSteeredAnnouncement({
        mode,
        queueEmbeddedAgentMessageWithOutcome,
        requesterOrigin: {
          channel: "slack",
          to: "channel:C123",
          accountId: "acct-1",
        },
      });

      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledOnce();
    },
  );

  it("preserves best-effort steering for active runtimes without transcript wait support", async () => {
    const queueEmbeddedAgentMessageWithOutcome = vi
      .fn<QueueEmbeddedAgentMessageWithOutcome>()
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
      queueEmbeddedAgentMessageWithOutcome,
      requesterOrigin: {
        channel: "slack",
        to: "channel:C123",
        accountId: "acct-1",
      },
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenNthCalledWith(
      1,
      "paperclip-session",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 120_000,
      },
    );
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenNthCalledWith(
      2,
      "paperclip-session",
      "child done",
      {
        steeringMode: "all",
        debounceMs: 500,
        deliveryTimeoutMs: 120_000,
      },
    );
  });

  it("waits through compaction and re-steers the active requester (86566)", async () => {
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      // First steer attempt observes a compacting run; once compaction ends the
      // same wake succeeds, so completion must stay on the steering path instead
      // of falling back to the direct requester-agent handoff.
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
        "compacting",
        true,
      ]);
      const callGateway = await deliverSteeredAnnouncement({
        queueEmbeddedAgentMessageWithOutcome,
        requesterOrigin: {
          channel: "slack",
          to: "channel:C123",
          accountId: "acct-1",
        },
      });

      expect(callGateway).not.toHaveBeenCalled();
      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
      const retryOptions = mockCallArg(queueEmbeddedAgentMessageWithOutcome, 1, 2);
      expectRecordFields(retryOptions, {
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
      });
      expect(retryOptions.deliveryTimeoutMs).toBeGreaterThan(0);
      expect(retryOptions.deliveryTimeoutMs).toBeLessThan(120_000);
    } finally {
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it("keeps retrying compaction past the backoff schedule until the delivery timeout (86566)", async () => {
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      // The backoff schedule has four entries, but a compaction that only
      // finishes after the schedule is exhausted should still be retried while
      // the run stays within the delivery timeout (120s here). Five compacting
      // outcomes (more than the schedule length) precede the queued success, so
      // the wake must keep retrying past the schedule instead of falling back.
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
        "compacting",
        "compacting",
        "compacting",
        "compacting",
        "compacting",
        true,
      ]);
      const callGateway = await deliverSteeredAnnouncement({
        queueEmbeddedAgentMessageWithOutcome,
        requesterOrigin: {
          channel: "slack",
          to: "channel:C123",
          accountId: "acct-1",
        },
      });

      expect(callGateway).not.toHaveBeenCalled();
      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(6);
    } finally {
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it("passes the remaining delivery window into compaction retries (86566)", async () => {
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      const queueEmbeddedAgentMessageWithOutcome = vi
        .fn<QueueEmbeddedAgentMessageWithOutcome>()
        .mockImplementationOnce((sessionId: string) => ({
          queued: false,
          sessionId,
          reason: "compacting",
          gatewayHealth: "live",
        }))
        .mockImplementationOnce((sessionId: string) => ({
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
        }));
      const callGateway = await deliverSteeredAnnouncement({
        announceTimeoutMs: 500,
        queueEmbeddedAgentMessageWithOutcome,
        requesterOrigin: {
          channel: "slack",
          to: "channel:C123",
          accountId: "acct-1",
        },
      });

      expect(callGateway).not.toHaveBeenCalled();
      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
      const retryOptions = mockCallArg(queueEmbeddedAgentMessageWithOutcome, 1, 2);
      expectRecordFields(retryOptions, {
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
      });
      expect(retryOptions.deliveryTimeoutMs).toBeGreaterThan(0);
      expect(retryOptions.deliveryTimeoutMs).toBeLessThan(500);
    } finally {
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it("does not retry non-compacting steer failures (86566)", async () => {
    // Only compacting is treated as transient; other wake failures keep their
    // existing single-attempt fallback behavior.
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "no_active_run",
      true,
    ]);
    const callGateway = createGatewayMock();
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: true,
      }),
      queueEmbeddedAgentMessageWithOutcome,
      getRuntimeConfig: () =>
        ({
          messages: { queue: { mode: "steer" } },
        }) as never,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:eng:paperclip:issue:123",
      targetRequesterSessionKey: "agent:eng:paperclip:issue:123",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-no-active-run-no-retry",
    });

    // Non-compacting failure is not retried: the steer is attempted once.
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledOnce();
    expectRecordFields(result, { path: "none" });
  });

  it("does not report delivery when active requester steering is rejected", async () => {
    const queueEmbeddedAgentMessageWithOutcome = vi.fn(async (sessionId: string) => ({
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
      queueEmbeddedAgentMessageWithOutcome,
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: "steer",
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
    const queueEmbeddedAgentMessageWithOutcome = vi.fn(async (sessionId: string) => ({
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
      queueEmbeddedAgentMessageWithOutcome,
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: "steer",
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

  it("falls through to direct delivery when steering is refused for a stale run", async () => {
    // An evidence-dead requester still registers as "active", but it will not
    // drain its steer queue; dropping here would discard the handoff.
    const queueEmbeddedAgentMessageWithOutcome = vi.fn(async (sessionId: string) => ({
      queued: false as const,
      sessionId,
      reason: "stale_run" as const,
      gatewayHealth: "live" as const,
    }));
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "child completion output" }],
      },
    });
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: true,
      }),
      queueEmbeddedAgentMessageWithOutcome,
      getRuntimeConfig: () =>
        ({
          messages: {
            queue: {
              mode: "steer",
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
      directIdempotencyKey: "announce-stale-run-direct-fallback",
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      directIdempotencyKey: "announce-1",
      queueEmbeddedAgentMessageWithOutcome,
    });

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 4_200,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
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

  it("waits through compaction on the completion handoff wake (86566)", async () => {
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      // The generated-completion active wake (expectsCompletionMessage) must also
      // wait through a compacting run and re-steer the same wake instead of
      // falling back to direct delivery.
      const callGateway = createGatewayMock();
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
        "compacting",
        true,
      ]);
      const result = await deliverSlackThreadAnnouncement({
        callGateway,
        sessionId: "requester-session-1",
        isActive: true,
        directIdempotencyKey: "announce-compaction-completion",
        queueEmbeddedAgentMessageWithOutcome,
      });

      expectDeliveryPath(result, "steered");
      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
  });

  it("does not also direct-run a queued active completion", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      directIdempotencyKey: "announce-harness-task",
      queueEmbeddedAgentMessageWithOutcome,
      sourceTool: "agent_harness_task",
    });

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 4_200,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps direct external delivery for dormant completion requesters", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-2",
      directIdempotencyKey: "announce-1b",
      queueEmbeddedAgentMessageWithOutcome,
    });

    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "directly delivers direct-message subagent text when the announce agent returns no visible output",
      payloads: [] as { text: string }[],
      event: { childSessionId: "child-session-id" },
      content: "child completion output",
      fullTarget: true,
      expectsMessageToolMode: false,
    },
    {
      name: "directly delivers direct-message subagent text when the announce agent replies NO_REPLY",
      payloads: [{ text: "NO_REPLY" }],
      event: {},
      content: "child completion output",
      fullTarget: false,
      expectsMessageToolMode: false,
    },
    {
      name: "directly delivers direct-message subagent text when the announce agent omits the result",
      payloads: [{ text: "TG88042_NO_REOUTPUT" }],
      event: { childSessionId: "child-session-id", result: "TG88042_CHILD" },
      content: "TG88042_CHILD",
      fullTarget: true,
      expectsMessageToolMode: true,
    },
  ])("$name", async ({ payloads, event, content, fullTarget, expectsMessageToolMode }) => {
    const callGateway = createGatewayMock({ result: { payloads } });
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents(event),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ...(fullTarget
          ? {
              channel: "discord",
              accountId: "acct-1",
              to: "dm:U123",
            }
          : {}),
        content,
        idempotencyKey: "announce-dm-fallback-empty:text-direct",
      }),
    );
    if (expectsMessageToolMode) {
      expectGatewayAgentParams(callGateway, {
        deliver: false,
        channel: "discord",
        accountId: "acct-1",
        to: "dm:U123",
        threadId: undefined,
        sourceReplyDeliveryMode: "message_tool_only",
      });
    }
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
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        status: "error",
        statusLabel: "failed: all models failed",
        result: "(no output)",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
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
      directIdempotencyKey: "announce-qa-fallback-empty",
      requesterSessionKey: "agent:qa:subagent-direct-fallback:1234",
      requesterOrigin: {
        channel: "qa-channel",
        to: "qa-operator",
        accountId: "default",
      },
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "qa direct completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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
      directIdempotencyKey: "announce-channel-direct-key-empty",
      requesterSessionKey: "agent:main:discord:dm:U123",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
      }),
    });

    expectDeliveryPath(result, "direct");
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
      sourceSessionKey: "agent:main:subagent:child",
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-dispatch",
    });

    expectDeliveryPath(result, "direct");
    expect(callGateway).not.toHaveBeenCalled();
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
      bestEffortDeliver: true,
    });
    const dispatchOptions = mockCallArg(dispatchGatewayMethodInProcess, 0, 2);
    expect(dispatchOptions).toMatchObject({
      allowSyntheticCronRunContinuation: false,
      expectFinal: true,
      forceSyntheticClient: true,
      delegatedToolPolicyHandoff: true,
      timeoutMs: 120_000,
    });
  });

  it.each([
    { name: "no payloads", result: { payloads: [] } },
    {
      name: "attachment payload without a usable media reference",
      result: { payloads: [{ attachments: [{}] }] },
    },
    {
      name: "tool calls without delivery evidence",
      result: { payloads: [], meta: { toolSummary: { calls: 1 } } },
    },
  ])(
    "fails session-only completion handoff when the in-process agent returns $name",
    async ({ result: agentResult }) => {
      const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
        result: agentResult,
      });
      testing.setDepsForTest({
        dispatchGatewayMethodInProcess,
        getRequesterSessionActivity: () => ({
          sessionId: "requester-session-local",
          isActive: false,
        }),
        getRuntimeConfig: () => ({}) as never,
      });

      const result = await deliverSubagentAnnouncement({
        requesterSessionKey: "agent:main:local-session",
        targetRequesterSessionKey: "agent:main:local-session",
        triggerMessage: "child done",
        steerMessage: "child done",
        requesterIsSubagent: false,
        expectsCompletionMessage: true,
        bestEffortDeliver: true,
        directIdempotencyKey: "announce-local-empty",
      });

      expectRecordFields(result, {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      });
      expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
        deliver: false,
        channel: undefined,
        to: undefined,
        bestEffortDeliver: true,
      });
    },
  );

  it("accepts non-subagent session-only completion handoff when the in-process agent intentionally replies NO_REPLY", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [{ text: "NO_REPLY" }],
      },
    });
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session-local",
        isActive: false,
      }),
      getRuntimeConfig: () => ({}) as never,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:local-session",
      targetRequesterSessionKey: "agent:main:local-session",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-silent",
      sourceTool: "agent_harness_task",
    });

    expectDeliveryPath(result, "direct");
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: false,
      channel: undefined,
      to: undefined,
      bestEffortDeliver: true,
    });
  });

  it("rejects session-only subagent completion handoff when the parent only replies NO_REPLY", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [{ text: "NO_REPLY" }],
      },
    });
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session-local",
        isActive: false,
      }),
      getRuntimeConfig: () => ({}) as never,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:local-session",
      targetRequesterSessionKey: "agent:main:local-session",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-subagent-silent",
      sourceTool: "subagent_announce",
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
      error: "completion agent did not produce a visible reply",
    });
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: false,
      channel: undefined,
      to: undefined,
      bestEffortDeliver: true,
    });
  });

  it.each([
    {
      name: "accepted session spawn",
      result: {
        payloads: [],
        acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:main:child" }],
      },
    },
    {
      name: "successful cron add",
      result: {
        payloads: [],
        successfulCronAdds: 1,
      },
    },
  ])("accepts session-only completion handoff with $name evidence", async ({ result }) => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result,
    });
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session-local",
        isActive: false,
      }),
      getRuntimeConfig: () => ({}) as never,
    });

    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:local-session",
      targetRequesterSessionKey: "agent:main:local-session",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-side-effect",
    });

    expectRecordFields(delivery, {
      delivered: true,
      path: "direct",
    });
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: false,
      channel: undefined,
      to: undefined,
      bestEffortDeliver: true,
    });
  });

  it("does not require generated media delivery for no-target cron completion handoffs", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [{ text: "cron saw generated media completion" }],
      },
    });
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess,
      queueEmbeddedAgentMessageWithOutcome,
      getRequesterSessionActivity: () => ({
        sessionId: "cron-run-session",
        isActive: true,
      }),
      getRuntimeConfig: () => ({}) as never,
      loadRequesterSessionEntry: (sessionKey) => ({
        cfg: {},
        entry: readyCronContinuationEntry("cron-run-session"),
        canonicalKey: sessionKey,
      }),
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:cron:media-job:run:run-123",
      targetRequesterSessionKey: "agent:main:cron:media-job:run:run-123",
      triggerMessage: "image done",
      steerMessage: "image done",
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-cron-media-no-target",
      sourceTool: "image_generate",
      sourceSessionKey: "image_generate:task-123",
      sourceChannel: "internal",
      internalEvents: imageCompletionEvents({
        taskLabel: "cron proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-cron-proof.png",
        mediaUrls: ["/tmp/generated-cron-proof.png"],
        replyInstruction: "Continue the cron job after the generated image is ready.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
      "cron-run-session",
      "image done",
      expect.objectContaining({
        waitForTranscriptCommit: true,
      }),
    );
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      deliver: false,
      sessionKey: "agent:main:cron:media-job:run:run-123",
    });
  });

  it("keeps dashboard music completions on session-only handoff with generated media evidence", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [
          {
            text: "The generated music is ready.",
            attachments: [
              {
                type: "audio",
                path: "/tmp/generated-night-drive.mp3",
                mimeType: "audio/mpeg",
              },
            ],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session-dashboard",
        isActive: false,
      }),
      getRuntimeConfig: () => ({}) as never,
      sendMessage,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:dashboard:music-session",
      targetRequesterSessionKey: "agent:main:dashboard:music-session",
      triggerMessage: "music done\nMEDIA:/tmp/generated-night-drive.mp3",
      steerMessage: "music done\nMEDIA:/tmp/generated-night-drive.mp3",
      requesterOrigin: {
        channel: "webchat",
        to: "session:dashboard",
        accountId: "control-ui",
      },
      requesterSessionOrigin: {
        channel: "webchat",
        to: "session:dashboard",
        accountId: "control-ui",
      },
      completionDirectOrigin: {
        channel: "webchat",
        to: "session:dashboard",
        accountId: "control-ui",
      },
      directOrigin: {
        channel: "webchat",
        to: "session:dashboard",
        accountId: "control-ui",
      },
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-dashboard-music-media",
      sourceTool: "music_generate",
      sourceSessionKey: "music_generate:task-123",
      sourceChannel: "internal",
      internalEvents: musicCompletionEvents({
        replyInstruction: "Tell the user the music is ready and include the generated audio.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      sessionKey: "agent:main:dashboard:music-session",
      deliver: false,
      channel: "webchat",
      accountId: "control-ui",
      to: "session:dashboard",
      bestEffortDeliver: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
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
      directIdempotencyKey: "announce-thread-fallback-1",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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

  it.each([
    {
      name: "keeps requester-agent output primary even when it is a child-result prefix",
      text: "34/34 tests pass, clean build. Now docker repro:",
      idempotencyKey: "announce-thread-fallback-prefix",
    },
    {
      name: "keeps word-boundary requester-agent prefixes on the mediated path",
      text: "34/34 tests pass, clean build. Now docker repro",
      idempotencyKey: "announce-thread-fallback-word-prefix",
    },
    {
      name: "keeps mid-word requester-agent prefixes on the mediated path",
      text: "34/34 tests pass, clean build. Now dock",
      idempotencyKey: "announce-thread-fallback-midword-prefix",
    },
  ])("$name", async ({ text, idempotencyKey }) => {
    const callGateway = createGatewayMock({ result: { payloads: [{ text }] } });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: idempotencyKey,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
        result: longChildCompletionOutput,
      }),
    });

    expectDeliveryPath(result, "direct");
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
      directIdempotencyKey: "announce-thread-delivery-status-failed",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
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
      directIdempotencyKey: "announce-thread-fallback-grouped-results",
      internalEvents: [
        createTaskCompletionEvent({
          childSessionKey: "agent:worker:subagent:first",
          childSessionId: "child-session-1",
          taskLabel: "first task",
          result: "first child result",
        }),
        createTaskCompletionEvent({
          childSessionKey: "agent:worker:subagent:second",
          childSessionId: "child-session-2",
          taskLabel: "second task",
          result: "second child result",
        }),
      ],
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats stale thread subagent completions as delivered after parent handoff", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      isActive: true,
      directIdempotencyKey: "announce-thread-fallback-empty",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenNthCalledWith(
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
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenNthCalledWith(
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

  it.each([
    {
      name: "keeps concise requester rewrites primary even when child output is long",
      text: "Tests passed and the PR is ready for review.",
      idempotencyKey: "announce-thread-rewrite-primary",
    },
    {
      name: "keeps copied complete-sentence requester summaries primary",
      text: "34/34 tests pass, clean build.",
      idempotencyKey: "announce-thread-copied-summary-primary",
    },
  ])("$name", async ({ text, idempotencyKey }) => {
    const callGateway = createGatewayMock({ result: { payloads: [{ text }] } });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: idempotencyKey,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
        result: longChildCompletionOutput,
      }),
    });

    expectDeliveryPath(result, "direct");
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
      directIdempotencyKey: "announce-thread-fallback-1",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
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
      queueEmbeddedAgentMessageWithOutcome: createQueueOutcomeMock(false),
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
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "telegram completion smoke",
      }),
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      isActive: true,
      runtimeConfig: {
        agents: {
          defaults: {
            subagents: {
              announceTimeoutMs: 10,
            },
          },
        },
      },
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "telegram wake smoke",
      }),
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
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
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

  it("does not restart an abandoned requester session for late completion delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "child completion output" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverTelegramDirectMessageCompletion({
      callGateway,
      sendMessage,
      requesterAbandoned: true,
      isActive: false,
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "telegram late completion",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    expect(result.phases).toEqual([
      expect.objectContaining({
        phase: "direct-primary",
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      }),
      expect.objectContaining({
        phase: "steer-fallback",
        delivered: false,
        path: "none",
      }),
    ]);
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
  });

  it("uses steer fallback when a completion handoff has no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const queueEmbeddedAgentMessageWithOutcome = vi
      .fn<QueueEmbeddedAgentMessageWithOutcome>()
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
      isActive: true,
      directIdempotencyKey: "announce-channel-empty-direct-steer-fallback",
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
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
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("does not fail stale thread subagent completions only because the parent stayed private", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      isActive: true,
      directIdempotencyKey: "announce-thread-fallback-empty",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "thread completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps generated media DMs on the session agent loop when the first turn has no output", async () => {
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
      durableGeneratedMediaHandoff: true,
      internalEvents: musicCompletionEvents(),
    });

    expectDeliveryPath(result, "queued");
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReplyDeliveryMode: "automatic" }),
      expect.any(Number),
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it.each([
    {
      name: "fails closed when durable agent-loop persistence is unavailable",
      createCallGateway: () => createGatewayMock({ result: { payloads: [] } }),
      event: { childSessionId: "task-123" },
    },
    {
      name: "does not race an in-flight agent turn when durable persistence failed",
      createCallGateway: () =>
        createGatewayMock({
          runId: "music_generate:task-in-flight:agent-loop",
          status: "in_flight",
        }),
      event: { childSessionKey: "music_generate:task-in-flight" },
    },
    {
      name: "fails closed after cancellation when persistence is unavailable",
      createCallGateway: () => createGatewayMock({ result: { payloads: [] } }),
      event: { childSessionKey: "music_generate:task-cancelled-persistence" },
      aborted: true,
    },
    {
      name: "does not start an agent turn after ambiguous persistence failure",
      createCallGateway: () =>
        vi.fn(async () => {
          throw new Error("gateway agent setup failed before dispatch");
        }) as unknown as typeof runtimeCallGateway,
      event: { childSessionKey: "music_generate:task-predispatch" },
    },
    {
      name: "does not report attachment-less success after ambiguous persistence failure",
      createCallGateway: () =>
        vi.fn(async () => {
          throw new Error("gateway agent setup failed before dispatch");
        }) as unknown as typeof runtimeCallGateway,
      event: {
        childSessionKey: "music_generate:task-empty-predispatch",
        taskLabel: "attachment-less generation",
        result: "generation completed without a resolved attachment",
        mediaUrls: undefined,
        replyInstruction: "Tell the user the generation completed.",
      },
    },
    {
      name: "does not deliver a failure notice after ambiguous persistence failure",
      createCallGateway: () =>
        vi.fn(async () => {
          throw new Error("SessionWriteLockTimeoutError: session file locked before agent run");
        }) as unknown as typeof runtimeCallGateway,
      event: {
        childSessionKey: "music_generate:task-failed",
        status: "error" as const,
        statusLabel: "failed",
        result: "all providers failed",
        mediaUrls: undefined,
        replyInstruction: "Tell the user music generation failed.",
      },
    },
    {
      name: "does not deliver a no-output notice after ambiguous persistence failure",
      createCallGateway: () => createGatewayMock({ result: { payloads: [] } }),
      event: {
        childSessionKey: "music_generate:task-failed-empty",
        status: "error" as const,
        statusLabel: "failed",
        result: "all providers failed",
        mediaUrls: undefined,
        replyInstruction: "Tell the user music generation failed.",
      },
    },
    {
      name: "does not inspect agent output after ambiguous persistence failure",
      createCallGateway: () =>
        createGatewayMock({
          result: {
            payloads: [],
            messagingToolSentTargets: [
              {
                tool: "message",
                provider: "discord",
                accountId: "acct-1",
                to: "dm:U123",
                text: "Music generation failed: all providers failed",
                mediaUrls: [],
              },
            ],
          },
        }),
      event: {
        childSessionKey: "music_generate:task-failed-delivered",
        status: "error" as const,
        statusLabel: "failed",
        result: "all providers failed",
        mediaUrls: undefined,
        replyInstruction: "Tell the user music generation failed.",
      },
    },
    {
      name: "does not report successful generation after ambiguous persistence failure",
      createCallGateway: () => createGatewayMock({ result: { payloads: [] } }),
      event: {
        childSessionKey: "music_generate:task-empty-success",
        result: "generation completed without a resolved attachment",
        mediaUrls: undefined,
        replyInstruction: "Tell the user the generation completed.",
      },
    },
  ])("$name", async ({ createCallGateway, event, aborted }) => {
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockRejectedValueOnce(
      new Error("state database unavailable"),
    );
    const callGateway = createCallGateway();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      signal: aborted ? AbortSignal.abort() : undefined,
      sourceTool: "music_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: musicCompletionEvents(event),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "queued",
      reason: "completion_handoff_unavailable",
      terminal: true,
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "fails closed when a conflicting durable row status is temporarily unknown",
      status: "unknown" as const,
      expected: {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_pending",
      },
      schedulesRetry: true,
    },
    {
      name: "does not report or replay a dead-lettered durable handoff",
      status: "failed" as const,
      expected: {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_unavailable",
        terminal: true,
      },
      schedulesRetry: false,
    },
    {
      name: "accepts a durable handoff completed by a competing owner",
      status: "completed" as const,
      expected: { delivered: true, path: "queued" },
      schedulesRetry: false,
    },
  ])("$name", async ({ status, expected, schedulesRetry }) => {
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockResolvedValueOnce({
      id: "session-delivery-media",
      claimed: false,
      status,
    });
    const callGateway = createGatewayMock({ result: { payloads: [] } });
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: musicCompletionEvents(),
    });

    expectRecordFields(result, expected);
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const scheduleExpectation = expect(sessionDeliveryQueueMocks.scheduleSessionDelivery);
    if (schedulesRetry) {
      scheduleExpectation.toHaveBeenCalledWith("session-delivery-media");
    } else {
      scheduleExpectation.not.toHaveBeenCalled();
    }
  });

  it("keeps an aborted durable handoff pending for retry", async () => {
    const controller = new AbortController();
    controller.abort();
    const callGateway = createGatewayMock({ result: { payloads: [] } });

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sourceTool: "music_generate",
      signal: controller.signal,
      durableGeneratedMediaHandoff: true,
      internalEvents: musicCompletionEvents({
        childSessionKey: "music_generate:task-aborted",
      }),
    });

    expectRecordFields(result, { delivered: true, path: "queued" });
    expect(callGateway).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.ackSessionDelivery).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.releaseSessionDeliveryClaim).toHaveBeenCalledWith(
      "session-delivery-media",
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it.each([
    {
      name: "does not fallback when announce-agent delivered media through the message tool",
      result: {
        payloads: [],
        didSendViaMessagingTool: false,
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
      fallsBack: false,
    },
    {
      name: "does not fallback when current-chat message-tool media also has target telemetry",
      result: {
        payloads: [],
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "message",
            to: undefined,
            threadId: undefined,
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
      },
      fallsBack: false,
    },
    {
      name: "falls back when targetless message-tool media names a different provider",
      result: {
        payloads: [],
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: undefined,
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
      },
      fallsBack: true,
    },
    {
      name: "falls back when message-tool media went to a different target",
      result: {
        payloads: [],
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:OTHER",
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
      },
      fallsBack: true,
    },
    {
      name: "falls back when message-tool media went to a thread instead of the source channel",
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            threadId: "thread-1",
            text: "The track is ready.",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
          },
        ],
      },
      fallsBack: true,
    },
    {
      name: "does not fallback when message-tool evidence already contains generated media",
      result: {
        payloads: [{ text: "The track is ready.", mediaUrls: ["/tmp/generated-night-drive.mp3"] }],
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
      fallsBack: false,
    },
    {
      name: "does not ignore targetless message-tool media when another send had a target",
      result: {
        payloads: [],
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:OTHER",
            text: "Side note.",
            mediaUrls: ["/tmp/other.mp3"],
          },
        ],
      },
      fallsBack: false,
    },
  ])("$name", async ({ result: gatewayResult, fallsBack }) => {
    const callGateway = createGatewayMock({ result: gatewayResult });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
      internalEvents: musicCompletionEvents({
        replyInstruction: "Deliver the generated music through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectDiscordDirectAgentParams(callGateway);
    const fallbackExpectation = expect(sendMessage);
    if (fallsBack) {
      fallbackExpectation.toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          accountId: "acct-1",
          to: "dm:U123",
          content: "The generated music is ready.",
          mediaUrls: ["/tmp/generated-night-drive.mp3"],
          idempotencyKey: "announce-dm-fallback-empty:generated-media-direct",
        }),
      );
    } else {
      fallbackExpectation.not.toHaveBeenCalled();
    }
  });

  it("accepts generated media completion DMs from requester-agent delivery evidence", async () => {
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
      internalEvents: musicCompletionEvents({
        replyInstruction:
          "Tell the user the music is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expectDiscordDirectAgentParams(callGateway);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("stringifies Telegram topic ids for generated video completion handoff", async () => {
    const callGateway = createGatewayMock({
      payloads: [],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          accountId: "bot-1",
          to: "telegram:-1003970070733",
          threadId: "1",
          text: "The video is ready.",
          mediaUrls: ["/tmp/generated-corgi.mp4"],
        },
      ],
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
      internalEvents: taskCompletionEvents({
        source: "video_generation",
        childSessionKey: "video_generate:task-123",
        childSessionId: "task-123",
        announceType: "video generation task",
        taskLabel: "anime corgi skateboard",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-corgi.mp4",
        mediaUrls: ["/tmp/generated-corgi.mp4"],
        replyInstruction: "Deliver the generated video through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:-1003970070733",
      threadId: "1",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("accepts generated image completion DMs from requester-agent delivery evidence", async () => {
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
      internalEvents: imageCompletionEvents({
        taskLabel: "small watercolor robot",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-robot.png",
        mediaUrls: ["/tmp/generated-robot.png"],
        replyInstruction: "Tell the user the image is ready and send it through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expectDiscordDirectAgentParams(callGateway);
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
      internalEvents: musicCompletionEvents({
        status: "error",
        statusLabel: "failed",
        result: "provider failed",
        mediaUrls: undefined,
        replyInstruction: "Deliver the failure through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expectDiscordDirectAgentParams(callGateway);
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
      internalEvents: musicCompletionEvents({
        result: "Generated 1 track.",
        mediaUrls: undefined,
        attachments: [
          {
            type: "audio",
            path: "/tmp/generated-night-drive.mp3",
            mimeType: "audio/mpeg",
            name: "generated-night-drive.mp3",
          },
        ],
      }),
    });

    expectDeliveryPath(result, "direct");
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
      internalEvents: musicCompletionEvents({
        status: "error",
        statusLabel: "failed",
        result: "All music generation models failed.",
        mediaUrls: undefined,
        replyInstruction: "Tell the user music generation failed.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expectDiscordDirectAgentParams(callGateway);
  });

  it("queues generated media group completions that miss required message-tool delivery", async () => {
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
      directIdempotencyKey: "announce-channel-media-message-tool",
      sourceTool: "music_generate",
      durableGeneratedMediaHandoff: true,
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: musicCompletionEvents({
        replyInstruction:
          "Tell the user the music is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("accepts targetless current-chat message-tool media delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentMediaUrls: ["/tmp/generated-night-drive.mp3"],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-targetless-message-tool",
      sourceTool: "music_generate",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: musicCompletionEvents({
        replyInstruction: "Tell the user the music is ready and send it through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not resend generated media when delivery evidence uses an equivalent file URL", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        messagingToolSentMediaUrls: ["file:///tmp/generated%20night%20drive.mp3"],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-normalized-message-tool",
      sourceTool: "music_generate",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: musicCompletionEvents({
        result: "Generated 1 track.\nMEDIA:/tmp/generated night drive.mp3",
        mediaUrls: ["/tmp/generated night drive.mp3"],
        replyInstruction: "Tell the user the music is ready and send it through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("accepts payload-only generated media when message tool sent text only", async () => {
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
      directIdempotencyKey: "announce-channel-media-text-only-message-tool",
      sourceTool: "music_generate",
      internalEvents: musicCompletionEvents({
        replyInstruction: "Tell the user the music is ready and send it through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).not.toHaveBeenCalled();
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
      directIdempotencyKey: "announce-channel-media-partial-message-tool",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction:
          "Tell the user the images are ready and send them through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
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

  it("reports only missing media when direct partial-delivery repair fails before send", async () => {
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
    const sendMessage = vi.fn(async () => {
      throw new Error("upload unavailable before send");
    }) as unknown as typeof runtimeSendMessage;

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-partial-repair-failed",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction: "Tell the user the images are ready and send them.",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      missingMediaUrls: ["/tmp/generated-robot-2.png"],
    });
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).not.toHaveBeenCalled();
  });

  it("directly delivers only missing generated media after partial automatic delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
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
      directIdempotencyKey: "announce-channel-media-partial-automatic",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction: "Tell the user the images are ready and include the generated media.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated image is ready.",
        mediaUrls: ["/tmp/generated-robot-2.png"],
        idempotencyKey: "announce-channel-media-partial-automatic:generated-media-direct",
      }),
    );
  });

  it("retries the session agent when automatic generated-media delivery fails", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The image is ready.",
            mediaUrls: ["/tmp/generated-robot.png"],
          },
        ],
        deliveryStatus: {
          status: "failed",
          errorMessage: "channel upload failed",
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-automatic-failed",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: imageCompletionEvents({
        taskLabel: "proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-robot.png",
        mediaUrls: ["/tmp/generated-robot.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("directly delivers generated media suppressed by automatic final delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "First image",
            mediaUrls: ["/tmp/generated-robot-1.png"],
          },
          {
            text: "Second image",
            mediaUrls: ["/tmp/generated-robot-2.png"],
          },
        ],
        deliveryStatus: {
          status: "sent",
          payloadOutcomes: [
            { index: 0, status: "sent", resultCount: 1 },
            {
              index: 1,
              status: "suppressed",
              reason: "cancelled_by_message_sending_hook",
            },
          ],
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-automatic-suppressed",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction: "Tell the user the images are ready and include the generated media.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        content: "The generated image is ready.",
        mediaUrls: ["/tmp/generated-robot-2.png"],
        idempotencyKey: "announce-channel-media-automatic-suppressed:generated-media-direct",
      }),
    );
  });

  it("keeps private generated media on the owning session agent loop", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The image is ready.",
            mediaUrls: ["/tmp/generated-private.png"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-subagent-session",
        isActive: false,
      }),
      getRuntimeConfig: () =>
        ({ messages: { groupChat: { visibleReplies: "message_tool" } } }) as never,
      loadRequesterSessionEntry: (sessionKey) => ({
        cfg: {},
        entry: {
          sessionId: "requester-subagent-session",
          updatedAt: 1,
          chatType: "channel",
        },
        canonicalKey: sessionKey,
      }),
      sendMessage,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:worker:subagent:parent",
      targetRequesterSessionKey: "agent:worker:subagent:parent",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: true,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-private-media-payload",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: imageCompletionEvents({
        taskLabel: "private proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-private.png",
        mediaUrls: ["/tmp/generated-private.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          channel: "webchat",
          to: "agent:worker:subagent:parent",
          chatType: "direct",
        },
        sourceReplyDeliveryMode: "automatic",
      }),
      expect.any(Number),
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("keeps generated media queued when direct fallback fails before delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = vi.fn(async () => {
      throw new Error("bot blocked before upload");
    }) as unknown as typeof runtimeSendMessage;
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-send-failed",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: imageCompletionEvents({
        taskLabel: "proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-robot.png",
        mediaUrls: ["/tmp/generated-robot.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("does not attempt raw media fallback before the session agent delivers anything", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = vi.fn(async () => {
      throw new OutboundDeliveryError("second upload failed", {
        cause: new Error("second upload failed"),
        results: [{ channel: "slack", messageId: "msg-1" }],
      });
    }) as unknown as typeof runtimeSendMessage;
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-send-partial",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: imageCompletionEvents({
        taskLabel: "proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-robot.png",
        mediaUrls: ["/tmp/generated-robot.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("dead-letters a partial automatic send with ambiguous transport evidence", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "First image",
            mediaUrls: ["/tmp/generated-robot-1.png"],
          },
          {
            text: "Second image",
            mediaUrls: ["/tmp/generated-robot-2.png"],
          },
        ],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "second upload failed",
          payloadOutcomes: [
            { index: 0, status: "sent", resultCount: 1 },
            {
              index: 1,
              status: "failed",
              error: "second upload failed",
              sentBeforeError: true,
            },
          ],
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-automatic-partial-failed",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction: "Tell the user the images are ready and include the generated media.",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      terminal: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).not.toHaveBeenCalled();
  });

  it("dead-letters incomplete partial-send evidence instead of duplicating attachments", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "The images are ready.",
            mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
          },
        ],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "second upload failed",
          payloadOutcomes: [
            {
              index: 0,
              status: "failed",
              error: "second upload failed",
            },
          ],
        },
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-automatic-partial-ambiguous",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction: "Tell the user the images are ready and include the generated media.",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      terminal: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.ackSessionDelivery).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).not.toHaveBeenCalled();
  });

  it("keeps generated media completions on the active requester session path", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      isActive: true,
      directIdempotencyKey: "announce-channel-media-active-direct",
      sourceTool: "video_generate",
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        source: "video_generation",
        childSessionKey: "video_generate:task-123",
        childSessionId: "task-123",
        announceType: "video generation task",
        taskLabel: "corgi proof video",
        result: "Generated 1 video.\nMEDIA:/tmp/generated-corgi.mp4",
        mediaUrls: ["/tmp/generated-corgi.mp4"],
        replyInstruction:
          "Tell the user the video is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
      }),
    });

    expectRecordFields(result, {
      delivered: true,
      path: "steered",
      enqueuedAt: 4_100,
      deliveredAt: 4_200,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session-channel",
      "child done",
      {
        steeringMode: "all",
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      isActive: true,
      directIdempotencyKey: "announce-channel-media-active-wake-failed",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        taskLabel: "two proof images",
        result:
          "Generated 2 images.\nMEDIA:/tmp/generated-robot-1.png\nMEDIA:/tmp/generated-robot-2.png",
        mediaUrls: ["/tmp/generated-robot-1.png", "/tmp/generated-robot-2.png"],
        replyInstruction:
          "Tell the user the images are ready and send them through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalled();
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

  it("keeps generated media queued for the session agent after a requester handoff lock", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error(
        "SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=43",
      );
    }) as unknown as typeof runtimeCallGateway;
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      isActive: true,
      directIdempotencyKey: "announce-channel-media-handoff-locked",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: imageCompletionEvents({
        childSessionKey: "image_generate:task-locked",
        childSessionId: "task-locked",
        taskLabel: "locked handoff image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-locked.png",
        mediaUrls: ["/tmp/generated-locked.png"],
        replyInstruction: "Tell the user the image is ready and send it through the message tool.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agentTurn",
        sessionKey: "agent:main:slack:channel:C123",
        message: expect.stringContaining("generated-locked.png"),
        messageId: "announce-channel-media-handoff-locked:agent-loop",
        route: {
          channel: "slack",
          to: "channel:C123",
          accountId: "acct-1",
          chatType: "channel",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/generated-locked.png"],
        idempotencyKey: "announce-channel-media-handoff-locked:agent-loop",
      }),
      expect.any(Number),
    );
    expect(sessionDeliveryQueueMocks.ackSessionDelivery).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("keeps generic requester handoff errors visible after active wake failure", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("requester handoff exploded after dispatch");
    }) as unknown as typeof runtimeCallGateway;
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const sendMessage = createSendMessageMock();

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      isActive: true,
      directIdempotencyKey: "announce-channel-media-handoff-error",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: imageCompletionEvents({
        childSessionKey: "image_generate:task-error",
        childSessionId: "task-error",
        taskLabel: "errored handoff image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-error.png",
        mediaUrls: ["/tmp/generated-error.png"],
        replyInstruction: "Tell the user the image is ready and send it through the message tool.",
      }),
    });

    expectDeliveryPath(result, "queued");
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("runs inactive isolated cron media completions through the requester agent first", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [{ text: "queued the generated image confirmation" }],
        messagingToolSentTargets: [
          {
            tool: "sessions_send",
            provider: "slack",
            to: "channel:C123",
            text: "The daily media workflow continued after the image callback.",
            mediaUrls: ["/tmp/generated-daily.png"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway: createGatewayMock(),
      dispatchGatewayMethodInProcess,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      requesterSessionEntry: readyCronContinuationEntry("stale-cron-run-session"),
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      directIdempotencyKey: "announce-stale-cron-media",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents(),
      sourceSessionKey: "image_generate:task-123",
      sourceChannel: "internal",
    });

    expectDeliveryPath(result, "direct");
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
    const params = expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      idempotencyKey: "announce-stale-cron-media",
    });
    expectRecordFields(params.inputProvenance, {
      kind: "inter_session",
      sourceSessionKey: "image_generate:task-123",
      sourceChannel: "internal",
      sourceTool: "image_generate",
    });
    expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 2)).toMatchObject({
      allowSyntheticCronRunContinuation: true,
      forceSyntheticClient: true,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refreshes a rotated cron session before retrying a concurrent media wake", async () => {
    const unavailable = Object.assign(new Error("cron run continuation is not ready"), {
      gatewayCode: "UNAVAILABLE",
    });
    const oldReady = readyCronContinuationEntry("old-session-id");
    const newReady = readyCronContinuationEntry("new-session-id");
    let currentEntry = oldReady;
    const dispatchGatewayMethodInProcess = vi
      .fn()
      .mockImplementationOnce(async () => {
        currentEntry = newReady;
        throw unavailable;
      })
      .mockResolvedValue({
        result: { payloads: [{ text: "continued after rotation" }] },
      }) as unknown as typeof runtimeDispatchGatewayMethodInProcess;

    const result = await deliverSlackChannelAnnouncement({
      callGateway: createGatewayMock(),
      dispatchGatewayMethodInProcess,
      queueEmbeddedAgentMessageWithOutcome: createQueueOutcomeMock(false),
      sessionId: "old-session-id",
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      resolveRequesterSessionEntry: () => currentEntry,
      directIdempotencyKey: "announce-retry-rotated-cron-session",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        result: "Generated image.",
        mediaUrls: undefined,
        replyInstruction: "Continue the cron task.",
      }),
    });

    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(dispatchGatewayMethodInProcess, 0, 1), {
      sessionId: "old-session-id",
    });
    expectRecordFields(mockCallArg(dispatchGatewayMethodInProcess, 1, 1), {
      sessionId: "new-session-id",
    });
  });

  it("keeps a busy exact cron continuation pending after bounded gateway retries", async () => {
    vi.useFakeTimers();
    try {
      const unavailable = Object.assign(new Error("cron run continuation is not ready"), {
        gatewayCode: "UNAVAILABLE",
      });
      const dispatchGatewayMethodInProcess = vi.fn(async () => {
        throw unavailable;
      }) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
      const running = {
        ...readyCronContinuationEntry("run-123"),
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "running" as const },
      };
      const delivery = deliverSlackChannelAnnouncement({
        callGateway: createGatewayMock(),
        dispatchGatewayMethodInProcess,
        queueEmbeddedAgentMessageWithOutcome: createQueueOutcomeMock(false),
        sessionId: "run-123",
        requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
        requesterSessionEntries: [running],
        directIdempotencyKey: "announce-cron-owner-timeout",
        sourceTool: "image_generate",
        durableGeneratedMediaHandoff: true,
        internalEvents: imageCompletionEvents({
          childSessionId: undefined,
          result: "Generated image.",
          mediaUrls: undefined,
          replyInstruction: "Continue the cron task.",
        }),
      });

      await vi.runAllTimersAsync();
      await expect(delivery).resolves.toMatchObject({
        delivered: true,
        path: "queued",
      });
      expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
      expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
        "session-delivery-media",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps inactive isolated cron media on the requester agent loop after a missed delivery", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      requesterSessionEntry: readyCronContinuationEntry("stale-cron-run-session"),
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      directIdempotencyKey: "announce-stale-cron-media-fallback",
      sourceTool: "image_generate",
      durableGeneratedMediaHandoff: true,
      internalEvents: imageCompletionEvents(),
      sourceSessionKey: "image_generate:task-123",
      sourceChannel: "internal",
    });

    expectDeliveryPath(result, "queued");
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("no-ops stale isolated cron run text completions", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      requesterSessionEntry: readyCronContinuationEntry("stale-cron-run-session"),
      requesterSessionKey: "agent:main:cron:daily-text:run:run-123",
      directIdempotencyKey: "announce-stale-cron-text",
      sourceTool: "subagent_announce",
    });

    expectRecordFields(result, {
      delivered: true,
      path: "none",
      phases: [{ phase: "direct-primary", delivered: true, path: "none", error: undefined }],
    });
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "stale-cron-run-session",
      requesterSessionEntry: readyCronContinuationEntry("stale-cron-run-session"),
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      directIdempotencyKey: "announce-stale-cron-media-failure",
      sourceTool: "image_generate",
      internalEvents: imageCompletionEvents({
        status: "error",
        statusLabel: "failed",
        result: "Provider timed out.",
        mediaUrls: undefined,
        replyInstruction: "Tell the user image generation failed.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
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
    "uses automatic delivery for generated media completions in $name sessions",
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
        directIdempotencyKey: `announce-legacy-media-message-tool-${origin.channel}`,
        requesterSessionKey,
        requesterOrigin: origin,
        sourceTool: "music_generate",
        internalEvents: musicCompletionEvents({
          replyInstruction:
            "Tell the user the music is ready. If visible source delivery requires the message tool, send it there with the generated media attached.",
        }),
      });

      expectDeliveryPath(result, "direct");
      expectGatewayAgentParams(callGateway, {
        deliver: true,
        channel: origin.channel,
        accountId: "acct-1",
        to: origin.to,
        threadId: undefined,
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
      directIdempotencyKey: "announce-channel-media-message-tool-evidence",
      sourceTool: "music_generate",
      internalEvents: musicCompletionEvents({
        replyInstruction: "Deliver the generated music through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
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
      directIdempotencyKey: "announce-channel-media-pending",
      sourceTool: "video_generate",
      internalEvents: taskCompletionEvents({
        source: "video_generation",
        childSessionKey: "video_generate:task-123",
        childSessionId: "task-123",
        announceType: "video generation task",
        taskLabel: "lobster trailer",
        result: "Generated 1 video.\nMEDIA:/tmp/lobster-trailer.mp4",
        mediaUrls: ["/tmp/lobster-trailer.mp4"],
        replyInstruction: "Deliver the generated video through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
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
      directIdempotencyKey: "announce-channel-media-pending-fallback-fails",
      sourceTool: "video_generate",
      internalEvents: taskCompletionEvents({
        source: "video_generation",
        childSessionKey: "video_generate:task-123",
        childSessionId: "task-123",
        announceType: "video generation task",
        taskLabel: "lobster trailer",
        result: "Generated 1 video.\nMEDIA:/tmp/lobster-trailer.mp4",
        mediaUrls: ["/tmp/lobster-trailer.mp4"],
        replyInstruction: "Deliver the generated video through the message tool.",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves pending completion announce delivery without media fallback", async () => {
    const callGateway = createGatewayMock({
      runId: "subagent:child:ok",
      status: "accepted",
      acceptedAt: Date.now(),
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-completion-pending",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "transcript_commit_wait_unsupported",
      "no_active_run",
    ]);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      queueEmbeddedAgentMessageWithOutcome,
      isActive: true,
      directIdempotencyKey: "announce-channel-fallback-empty",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-channel-subagent-message-tool",
      sourceTool: "subagent_announce",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-channel-subagent-message-tool-missing",
      sourceTool: "subagent_announce",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      reason: "message_tool_delivery_missing",
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
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:codex:subagent:child",
        childSessionId: "child-session-id",
        taskLabel: "telegram forum completion smoke",
        result: "delegated task output",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "telegram",
      accountId: "bot-1",
      to: "telegram:-1003871627242",
      threadId: "6823",
    });
  });

  it("requires message-tool delivery for direct subagent completions", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "The subagent is done: child completion output" }],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The subagent is done: child completion output"],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
      }),
    });

    expectDeliveryPath(result, "direct");
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

  it("retries active direct subagent completion wake without forced message-tool mode", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "The subagent is done: child completion output" }],
        didSendViaMessagingTool: true,
      },
    });
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
      "source_reply_delivery_mode_mismatch",
      true,
    ]);

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      isActive: true,
      queueEmbeddedAgentMessageWithOutcome,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "direct completion active wake",
      }),
    });

    expectDeliveryPath(result, "steered");
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(queueEmbeddedAgentMessageWithOutcome, 0, 2), {
      sourceReplyDeliveryMode: "message_tool_only",
      waitForTranscriptCommit: true,
    });
    const retryOptions = mockCallArg(queueEmbeddedAgentMessageWithOutcome, 1, 2);
    expectRecordFields(retryOptions, {
      waitForTranscriptCommit: true,
    });
    expect(
      (retryOptions as { sourceReplyDeliveryMode?: unknown }).sourceReplyDeliveryMode,
    ).toBeUndefined();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("falls back to the external requester route when completion origin is internal", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "child completion output" }],
      },
    });
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-channel-internal-origin",
      completionDirectOrigin: {
        channel: "webchat",
      },
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        taskLabel: "channel completion smoke",
      }),
    });

    expectDeliveryPath(result, "direct");
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

  it("does not retry session-file-changed failures with send evidence", async () => {
    const sendErr = new OutboundDeliveryError("outbound delivery failed", {
      cause: new Error("outbound delivery failed"),
      results: [{ channel: "telegram", messageId: "msg-1" }],
    });
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw new Error("session file changed while embedded prompt lock was released", {
        cause: sendErr,
      });
    });
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock(["no_active_run"]);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "requester-session-lock-race-evidence",
      isActive: true,
      directIdempotencyKey: "announce-permanent-lock-error-evidence",
    });

    expect(result.delivered).toBe(false);
    expect(result.path).toBe("direct");
    expect(result.terminal).toBe(true);
    expect(result.phases?.map((phase) => phase.phase)).toEqual(["direct-primary"]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
  });

  it("does not fallback-steer after wrapped prompt-lock takeover with send evidence", async () => {
    const takeoverErr = Object.assign(
      new Error("session file changed while embedded prompt lock was released: /tmp/session.jsonl"),
      { name: "EmbeddedAttemptSessionTakeoverError" },
    );

    const promptErr = Object.assign(new Error("some model error"), { visibleReplySent: true });
    const wrapperErr = Object.assign(new Error("some model error", { cause: takeoverErr }), {
      name: "EmbeddedAttemptSessionTakeoverError",
      cleanupError: takeoverErr,
      promptError: promptErr,
    });

    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw wrapperErr;
    });
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock(["no_active_run"]);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "requester-session-lock-race-wrapped-evidence",
      isActive: true,
      directIdempotencyKey: "announce-permanent-wrapped-lock-error-evidence",
    });

    expect(result.delivered).toBe(false);
    expect(result.path).toBe("direct");
    expect(result.error).toBe("some model error");
    expect(result.terminal).toBe(true);
    expect(result.phases?.map((phase) => phase.phase)).toEqual(["direct-primary"]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
  });

  it("retries session-file-changed failures without send evidence", async () => {
    let attempts = 0;
    const callGatewaySpy = vi.fn();
    const callGateway: typeof runtimeCallGateway = async <
      T = Record<string, unknown>,
    >(): Promise<T> => {
      callGatewaySpy();
      attempts++;
      if (attempts <= 1) {
        throw new Error("session file changed while embedded prompt lock was released");
      }
      return {
        result: {
          payloads: [{ text: "recovered after retry" }],
        },
      } as T;
    };
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock(["no_active_run"]);
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      queueEmbeddedAgentMessageWithOutcome,
      sessionId: "requester-session-lock-race-no-evidence",
      isActive: true,
      directIdempotencyKey: "announce-retry-lock-error-no-evidence",
    });

    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(callGatewaySpy).toHaveBeenCalledTimes(2);
  });

  it("detects send evidence from OutboundDeliveryError in the error chain", () => {
    const err = new Error(
      "session file changed while embedded prompt lock was released: /tmp/session.jsonl",
      {
        cause: new OutboundDeliveryError("outbound delivery failed", {
          cause: new Error("outbound delivery failed"),
          results: [{ channel: "telegram", messageId: "msg-1" }],
        }),
      },
    );

    expect(testing.isSessionFileChangedAnnounceError(err.message)).toBe(true);
    expect(testing.hasAnnounceSendEvidence(err)).toBe(true);
  });

  it("classifies session-file-changed error as no-send-evidence when the error chain has no send markers", () => {
    const err = new Error(
      "session file changed while embedded prompt lock was released: /tmp/session.jsonl",
    );

    expect(testing.isSessionFileChangedAnnounceError(err.message)).toBe(true);
    expect(testing.hasAnnounceSendEvidence(err)).toBe(false);
  });

  it("detects send evidence from visibleReplySent flag on session-file-changed error", () => {
    const err = Object.assign(
      new Error("session file changed while embedded prompt lock was released: /tmp/session.jsonl"),
      { visibleReplySent: true },
    );

    expect(testing.hasAnnounceSendEvidence(err)).toBe(true);
  });

  it("detects send evidence from sentBeforeError flag on session-file-changed error", () => {
    const err = Object.assign(
      new Error("session file changed while embedded prompt lock was released: /tmp/session.jsonl"),
      { sentBeforeError: true },
    );

    expect(testing.hasAnnounceSendEvidence(err)).toBe(true);
  });

  it("detects send evidence recursively through promptError", () => {
    const takeoverErr = Object.assign(
      new Error("session file changed while embedded prompt lock was released: /tmp/session.jsonl"),
      { name: "EmbeddedAttemptSessionTakeoverError" },
    );

    const promptErr = Object.assign(new Error("some model error"), { visibleReplySent: true });

    const wrapperErr = Object.assign(new Error("some model error", { cause: takeoverErr }), {
      name: "EmbeddedAttemptSessionTakeoverError",
      promptError: promptErr,
    });

    expect(testing.hasAnnounceSendEvidence(wrapperErr)).toBe(true);
    expect(testing.hasSessionFileChangedAnnounceError(wrapperErr)).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
