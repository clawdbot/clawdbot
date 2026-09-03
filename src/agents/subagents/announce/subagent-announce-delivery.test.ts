// Subagent announce delivery tests cover the last-mile routing used when child
// runs report progress or completion back to the requester session.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { InternalAgentTurnDispatchOptions } from "../../../gateway/agent-turn/internal-facade.types.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { authorizeGatewaySessionCreation } from "../../../gateway/operator-role-policy.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import type { dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import { buildSessionHistorySnapshot } from "../../../gateway/session-history-state.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../../infra/outbound/deliver-types.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import {
  testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
} from "../../../infra/outbound/session-binding-service.js";
import { normalizeLegacySessionEntryDelivery } from "../../../infra/state-migrations.legacy-session-store.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../internal-runtime-context.js";
import {
  createTaskCompletionEvent,
  expectDeliveryPath,
  expectRecordFields,
  imageCompletionEvents,
  mockCallArg,
  musicCompletionEvents,
  taskCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import {
  testing,
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
} from "./subagent-announce-delivery.test-support.js";
import { runDescendantWake } from "./subagent-announce-descendant-wake.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-origin.js";

const sessionDeliveryQueueMocks = vi.hoisted(() => ({
  enqueueClaimedSessionDelivery: vi.fn((_payload: unknown, _leaseMs: number) => ({
    id: "session-delivery-media",
    claimed: true,
    status: "pending" as "pending" | "failed" | "completed" | "unknown",
  })),
  releaseSessionDeliveryClaim: vi.fn(async () => {}),
  scheduleSessionDelivery: vi.fn(async () => true),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../completion/subagent-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../completion/subagent-completion-delivery.js")>()),
  admitCorrelatedSubagentSessionDelivery: (params: { payload: Record<string, unknown> }) =>
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery(params.payload, 125_000),
}));

vi.mock("../../../infra/session-delivery-queue-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/session-delivery-queue-storage.js")>()),
  enqueueClaimedSessionDelivery: sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim: sessionDeliveryQueueMocks.releaseSessionDeliveryClaim,
}));

vi.mock("../../../infra/session-delivery-queue-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/session-delivery-queue-runtime.js")>()),
  scheduleSessionDelivery: sessionDeliveryQueueMocks.scheduleSessionDelivery,
}));

type EmbeddedAgentQueueFailureReason = Extract<
  EmbeddedAgentQueueMessageOutcome,
  { queued: false }
>["reason"];

afterEach(() => {
  vi.useRealTimers();
  sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
  sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockClear();
  sessionDeliveryQueueMocks.releaseSessionDeliveryClaim.mockClear();
  sessionDeliveryQueueMocks.scheduleSessionDelivery.mockClear();
});

describe("queued completion handoff", () => {
  it.each(["delivered", "source retired", "execution timeout", "delivery deadline"] as const)(
    "keeps an accepted busy-parent completion pending until execution: %s",
    async (outcome) => {
      vi.useFakeTimers();
      const accepted = createDeferredCore<InternalAgentTurnDispatchOptions>();
      const parentSettled = createDeferredCore();
      const executionSettled = createDeferredCore();
      const executionStarted = createDeferredCore();
      const deliveryDeadline = new AbortController();
      let sourceAllowed = true;
      let executed = false;
      const dispatchGatewayMethodInProcess: typeof runtimeDispatchGatewayMethodInProcess = async <
        T,
      >(
        _method: string,
        _params: Record<string, unknown>,
        options?: InternalAgentTurnDispatchOptions,
      ) => {
        options?.onAccepted?.({ status: "accepted", runId: "completion-run" });
        accepted.resolve(options ?? {});
        const operation = parentSettled.promise.then(async () => {
          options?.onExecutionStarted?.();
          executed = true;
          executionStarted.resolve();
          await executionSettled.promise;
          return { result: { payloads: [{ text: "Parent received child result" }] } } as T;
        });
        return await waitForGatewayDispatch(
          "agent",
          operation,
          options?.timeoutMs,
          options?.signal,
        );
      };
      testing.setDepsForTest({
        dispatchGatewayMethodInProcess,
        getRuntimeConfig: () => ({}),
        getRequesterSessionActivity: () => ({ sessionId: "busy-parent", isActive: true }),
        queueEmbeddedAgentMessageWithOutcome: () => ({
          queued: false,
          reason: "no_active_run",
          sessionId: "busy-parent",
          gatewayHealth: "live",
        }),
      });
      let finished = false;
      const delivery = deliverSubagentAnnouncement({
        requesterSessionKey: "agent:main:subagent:parent",
        targetRequesterSessionKey: "agent:main:subagent:parent",
        requesterIsSubagent: true,
        expectsCompletionMessage: true,
        triggerMessage: "Child result ready",
        steerMessage: "Child result ready",
        directIdempotencyKey: "busy-parent-completion",
        isSourceSessionEffectsAllowed: () => sourceAllowed,
        signal: deliveryDeadline.signal,
      }).finally(() => {
        finished = true;
      });
      try {
        await accepted.promise;
        await vi.advanceTimersByTimeAsync(120_001);
        expect(finished).toBe(false);
        expect(executed).toBe(false);
        if (outcome === "delivery deadline") {
          deliveryDeadline.abort(new Error("completion delivery expired"));
          expect(await delivery).toMatchObject({ delivered: false, path: "none" });
          parentSettled.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(executed).toBe(false);
          return;
        }
        sourceAllowed = outcome !== "source retired";
        parentSettled.resolve();
        if (outcome === "execution timeout") {
          await executionStarted.promise;
          await vi.advanceTimersByTimeAsync(120_001);
          expect(await delivery).toMatchObject({
            delivered: false,
            error: "gateway request timeout for agent",
          });
          return;
        }
        executionSettled.resolve();
        expect(await delivery).toMatchObject(
          sourceAllowed
            ? { delivered: true, path: "direct" }
            : { delivered: false, reason: "source_owner_changed" },
        );
        expect(executed).toBe(sourceAllowed);
      } finally {
        parentSettled.resolve();
        executionSettled.resolve();
        await delivery;
      }
    },
  );
});

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;

function createGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async (opts: Parameters<typeof runtimeCallGateway>[0]) => {
    opts.onAccepted?.({ status: "accepted" });
    return response;
  }) as unknown as typeof runtimeCallGateway;
}

function createPayloadGatewayMock(...payloads: Record<string, unknown>[]) {
  return createGatewayMock({
    result: { payloads, ...(payloads.length > 0 ? { deliveryStatus: sentDeliveryStatus } : {}) },
  });
}

function createInProcessGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async () => response) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
}

function createRoleRestrictedInProcessGatewayMock(response: Record<string, unknown>) {
  const cfg = {
    gateway: {
      roles: {
        default: "restricted",
        definitions: {
          restricted: {
            agents: [],
            scopes: ["operator.write"],
            sessions: { others: "none" },
          },
        },
      },
    },
  } satisfies OpenClawConfig;
  const dispatchGatewayMethodInProcess = vi.fn(
    async (
      _method: string,
      _agentParams: Record<string, unknown>,
      options?: Parameters<typeof runtimeDispatchGatewayMethodInProcess>[2],
    ) => {
      const actor = options?.operatorRoleActor;
      const authorizationError = actor
        ? authorizeGatewaySessionCreation({ cfg, agentId: "main", actor })
        : authorizeGatewaySessionCreation({ cfg, agentId: "main", profileId: undefined });
      if (authorizationError) {
        throw new Error(`${authorizationError.code}: ${authorizationError.message}`);
      }
      return response;
    },
  ) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
  return { cfg, dispatchGatewayMethodInProcess };
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
) => EmbeddedAgentQueueMessageOutcome | Promise<EmbeddedAgentQueueMessageOutcome>;

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

async function createRequesterTranscriptFixture(sessionId: string) {
  const dir = tempDirs.make("openclaw-subagent-announce-transcript-");
  const sessionKey = "agent:main:slack:channel:C123:thread:171.222";
  const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const entry: SessionEntry = {
    sessionId,
    sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
    updatedAt: Date.now(),
  };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  return { agentId: "main", entry, sessionId, sessionKey, storePath };
}

async function readRequesterTranscriptMessages(fixture: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  return (
    await loadTranscriptEvents({
      agentId: fixture.agentId,
      sessionId: fixture.sessionId,
      sessionKey: fixture.sessionKey,
      storePath: fixture.storePath,
    })
  )
    .map((event) => (event as { message?: unknown }).message)
    .filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) && typeof message === "object" && !Array.isArray(message),
    );
}

const longChildCompletionOutput = [
  "34/34 tests pass, clean build. Now docker repro:",
  "Root cause: the requester's announce delivery accepted a prefix-only assistant payload as delivered.",
  "PR: https://github.com/openclaw/openclaw/pull/12345",
  "Verification: pnpm test src/agents/subagents/announce/subagent-announce-delivery.test.ts passed with the regression enabled.",
].join("\n");

const committedSessionSpawnEvidence = {
  acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:main:child" }],
} as const;

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
  sourceSessionKey?: string;
  sourceTool?: string;
  requesterAbandoned?: boolean;
  isSourceSessionEffectsAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterSessionActivity?: () => { sessionId: string; isActive: boolean };
  requesterTranscriptFixture?:
    | Awaited<ReturnType<typeof createRequesterTranscriptFixture>>
    | (() => Awaited<ReturnType<typeof createRequesterTranscriptFixture>>);
}) {
  // Slack thread delivery exercises all origins because direct, session, and
  // completion routing can differ after a child run outlives its requester.
  const requesterTranscriptFixture = params.requesterTranscriptFixture;
  const resolveRequesterTranscriptFixture =
    typeof requesterTranscriptFixture === "function"
      ? requesterTranscriptFixture
      : () => requesterTranscriptFixture;
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity:
      params.requesterSessionActivity ??
      (() => ({
        sessionId: params.sessionId ?? "requester-session-4",
        isActive: params.isActive === true,
      })),
    isRequesterSessionAbandoned: () => params.requesterAbandoned === true,
    getRuntimeConfig: () => ({}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.requesterTranscriptFixture
      ? {
          loadRequesterSessionEntry: (sessionKey: string) => {
            const fixture = resolveRequesterTranscriptFixture();
            return {
              cfg: {} as never,
              entry: fixture?.entry,
              canonicalKey: sessionKey,
              agentId: fixture?.agentId,
              storePath: fixture?.storePath,
            };
          },
        }
      : {}),
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
    sourceRunId: "run-generated-media",
    sourceSessionKey: params.sourceSessionKey,
    sourceTool: params.sourceTool,
    isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
    isCompletionOwnedByRequesterYield: params.isCompletionOwnedByRequesterYield,
  });
}

async function deliverDiscordDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
  isActive?: boolean;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  runtimeConfig?: Record<string, unknown>;
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  sourceSessionKey?: string;
  sourceTool?: string;
  signal?: AbortSignal;
  onDeliveryResult?: Parameters<typeof deliverSubagentAnnouncement>[0]["onDeliveryResult"];
  isSourceSessionEffectsAllowed?: () => boolean;
}) {
  const origin = {
    channel: "discord",
    to: "dm:U123",
    accountId: "acct-1",
  };
  const requesterSessionKey = params.requesterSessionKey ?? "agent:main:discord:dm:U123";
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-dm",
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
      : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey,
    requesterAgentId: params.requesterAgentId,
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
    directIdempotencyKey: "announce-dm-fallback-empty",
    internalEvents: params.internalEvents,
    sourceRunId: "run-generated-media",
    sourceSessionKey: params.sourceSessionKey,
    sourceTool: params.sourceTool,
    signal: params.signal,
    onDeliveryResult: params.onDeliveryResult,
    isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
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
    sourceRunId: "run-generated-media",
    sourceTool: params.sourceTool,
  });
}

async function deliverSlackChannelAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
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
  isSourceSessionEffectsAllowed?: () => boolean;
}) {
  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
  } as const;
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId ?? "requester-session-channel",
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    ...(params.requesterSessionEntry
      ? {
          loadRequesterSessionEntry: (sessionKey: string) => ({
            cfg: (params.runtimeConfig ?? {}) as never,
            entry: params.requesterSessionEntry,
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
    sourceRunId: "run-generated-media",
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool,
    isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
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
  it("loads a custom main alias through its canonical requester key", () => {
    const loadSessionEntry = vi.fn(() => ({ sessionId: "research-main", updatedAt: 1 }));
    testing.setDepsForTest({
      getRuntimeConfig: () =>
        ({
          session: { mainKey: "work", store: "/stores/shared.sqlite" },
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: {} },
          },
        }) as never,
      loadSessionEntry,
    });

    expect(loadRequesterSessionEntry("work", "research")).toMatchObject({
      canonicalKey: "agent:research:work",
      entry: { sessionId: "research-main" },
    });
    expect(loadSessionEntry).toHaveBeenCalledWith({
      agentId: "research",
      clone: false,
      sessionKey: "agent:research:work",
      storePath: "/stores/shared.sqlite",
    });
  });

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

  it("uses the requester agent when bare session keys collide", async () => {
    const cfg = {
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        list: [{ id: "ops" }, { id: "research" }],
      },
    } as never;
    const getRequesterSessionActivity = vi.fn(
      (_requesterSessionKey: string, requesterAgentId?: string) => ({
        sessionId: requesterAgentId === "research" ? "research-session" : "ops-session",
        isActive: true,
      }),
    );
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity,
      loadRequesterSessionEntry: (sessionKey: string) => ({
        cfg,
        entry: undefined,
        canonicalKey: sessionKey,
      }),
      queueEmbeddedAgentMessageWithOutcome,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "global",
      requesterAgentId: "research",
      targetRequesterSessionKey: "global",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-bare-key-agent-owner",
    });

    expectDeliveryPath(result, "steered");
    expect(getRequesterSessionActivity).toHaveBeenCalledWith("global", "research");
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
      "research-session",
      "child done",
      expect.objectContaining({ steeringMode: "all" }),
    );
  });

  it("fails closed for a restored bare requester key without an owner", async () => {
    const cfg = {
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        list: [{ id: "ops" }, { id: "research" }],
      },
    } as never;
    const getRequesterSessionActivity = vi.fn(() => ({
      sessionId: "ops-session",
      isActive: true,
    }));
    const loadSessionEntry = vi.fn(() => ({ sessionId: "ops-session", updatedAt: 1 }));
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity,
      loadSessionEntry,
      queueEmbeddedAgentMessageWithOutcome,
      callGateway: vi.fn(async () => {
        throw new Error("requester owner unavailable");
      }),
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "global",
      targetRequesterSessionKey: "global",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-ownerless-restored-entry",
    });

    expect(result.delivered).toBe(false);
    expect(getRequesterSessionActivity).not.toHaveBeenCalled();
    expect(loadSessionEntry).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
  });

  it("uses the persisted fixed-store owner for a restored bare requester key", async () => {
    const cfg = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        list: [{ id: "ops" }, { id: "research" }],
      },
    } as never;
    const getRequesterSessionActivity = vi.fn(() => ({
      sessionId: "ops-session",
      isActive: true,
    }));
    const loadSessionEntry = vi.fn(() => ({ sessionId: "ops-session", updatedAt: 1 }));
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity,
      loadSessionEntry,
      queueEmbeddedAgentMessageWithOutcome,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "global",
      targetRequesterSessionKey: "global",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-retained-restored-entry",
    });

    expectDeliveryPath(result, "steered");
    expect(getRequesterSessionActivity).toHaveBeenCalledWith("global", "ops");
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
      "ops-session",
      "child done",
      expect.objectContaining({ steeringMode: "all" }),
    );
  });

  it("loads a persisted custom bare requester under its durable storage key", async () => {
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as never;
    const getRequesterSessionActivity = vi.fn(() => ({
      sessionId: "ops-incident-session",
      isActive: true,
    }));
    const loadSessionEntry = vi.fn(() => ({
      sessionId: "ops-incident-session",
      updatedAt: 1,
    }));
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity,
      loadSessionEntry,
      queueEmbeddedAgentMessageWithOutcome,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "incident-42",
      targetRequesterSessionKey: "incident-42",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-persisted-bare-requester",
    });

    expectDeliveryPath(result, "steered");
    expect(loadSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops", sessionKey: "incident-42" }),
    );
    expect(getRequesterSessionActivity).toHaveBeenCalledWith("incident-42", "ops");
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
      "ops-incident-session",
      "child done",
      expect.objectContaining({ steeringMode: "all" }),
    );
  });

  it("rejects a restored bare requester whose explicit agent conflicts with the store owner", async () => {
    const cfg = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        list: [{ id: "ops" }, { id: "research" }],
      },
    } as never;
    const getRequesterSessionActivity = vi.fn(() => ({
      sessionId: "ops-session",
      isActive: true,
    }));
    const loadSessionEntry = vi.fn(() => ({ sessionId: "ops-session", updatedAt: 1 }));
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity,
      loadSessionEntry,
      queueEmbeddedAgentMessageWithOutcome,
      callGateway: vi.fn(async () => {
        throw new Error("requester owner conflict");
      }),
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "global",
      requesterAgentId: "research",
      targetRequesterSessionKey: "global",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-conflicting-restored-entry",
    });

    expect(result.delivered).toBe(false);
    expect(getRequesterSessionActivity).not.toHaveBeenCalled();
    expect(loadSessionEntry).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
  });

  it("fails closed for a restored bare requester key with a retired store owner", async () => {
    const cfg = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "retired" } },
        list: [{ id: "ops" }, { id: "research" }],
      },
    } as never;
    const getRequesterSessionActivity = vi.fn(() => ({
      sessionId: "ops-session",
      isActive: true,
    }));
    const loadSessionEntry = vi.fn(() => ({ sessionId: "ops-session", updatedAt: 1 }));
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity,
      loadSessionEntry,
      queueEmbeddedAgentMessageWithOutcome,
      callGateway: vi.fn(async () => {
        throw new Error("requester owner unavailable");
      }),
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "global",
      targetRequesterSessionKey: "global",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-retired-restored-entry",
    });

    expect(result.delivered).toBe(false);
    expect(getRequesterSessionActivity).not.toHaveBeenCalled();
    expect(loadSessionEntry).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
  });

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

  it.each([
    {
      name: "waits through compaction and re-steers the active requester (86566)",
      outcomes: ["compacting", true],
      announceTimeoutMs: undefined,
      retryWindowMs: 120_000,
    },
    {
      name: "keeps retrying compaction past the backoff schedule until the delivery timeout (86566)",
      outcomes: ["compacting", "compacting", "compacting", "compacting", "compacting", true],
      announceTimeoutMs: undefined,
      retryWindowMs: undefined,
    },
    {
      name: "passes the remaining delivery window into compaction retries (86566)",
      outcomes: ["compacting", true],
      announceTimeoutMs: 500,
      retryWindowMs: 500,
    },
  ] as const)("$name", async ({ outcomes, announceTimeoutMs, retryWindowMs }) => {
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      // Compaction remains retryable beyond the backoff schedule, but each
      // attempt must receive only the remaining delivery-timeout window.
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([...outcomes]);
      const callGateway = await deliverSteeredAnnouncement({
        ...(announceTimeoutMs === undefined ? {} : { announceTimeoutMs }),
        queueEmbeddedAgentMessageWithOutcome,
        requesterOrigin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
      });

      expect(callGateway).not.toHaveBeenCalled();
      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(outcomes.length);
      if (retryWindowMs !== undefined) {
        const retryOptions = mockCallArg(queueEmbeddedAgentMessageWithOutcome, 1, 2);
        expectRecordFields(retryOptions, {
          steeringMode: "all",
          debounceMs: 500,
          waitForTranscriptCommit: true,
        });
        expect(retryOptions.deliveryTimeoutMs).toBeGreaterThan(0);
        expect(retryOptions.deliveryTimeoutMs).toBeLessThan(retryWindowMs);
      }
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

  it("does not direct-fallback after source ownership changes during a compaction retry", async () => {
    let sourceEffectsAllowed = true;
    const queueEmbeddedAgentMessageWithOutcome = vi.fn((sessionId: string) => {
      sourceEffectsAllowed = false;
      return {
        queued: false as const,
        sessionId,
        reason: "compacting" as const,
        gatewayHealth: "live" as const,
      };
    });
    const callGateway = createGatewayMock();
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "paperclip-session",
        isActive: true,
      }),
      queueEmbeddedAgentMessageWithOutcome,
      getRuntimeConfig: () => ({ messages: { queue: { mode: "steer" } } }) as never,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:eng:paperclip:issue:123",
      targetRequesterSessionKey: "agent:eng:paperclip:issue:123",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-compaction-retired-source",
      isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledOnce();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not report delivery when active requester steering is rejected",
      reason: "runtime_rejected",
      errorMessage: "cannot steer a compact turn",
      activityEnds: false,
      fallsBack: false,
      directIdempotencyKey: "announce-rejected-steer",
    },
    {
      name: "falls through to direct delivery when requester ends during awaited steering failure",
      reason: "runtime_rejected",
      errorMessage: "active session ended before queued steering message was committed",
      activityEnds: true,
      fallsBack: true,
      directIdempotencyKey: "announce-recheck-after-steer-failure",
    },
    {
      name: "falls through to direct delivery when steering is refused for a stale run",
      reason: "stale_run",
      errorMessage: undefined,
      activityEnds: false,
      fallsBack: true,
      directIdempotencyKey: "announce-stale-run-direct-fallback",
    },
  ] as const)(
    "$name",
    async ({ reason, errorMessage, activityEnds, fallsBack, directIdempotencyKey }) => {
      // An active-but-stale requester cannot drain its queue and must still
      // receive the direct handoff; a live rejection must not fake delivery.
      const queueEmbeddedAgentMessageWithOutcome = vi.fn(async (sessionId: string) => ({
        queued: false as const,
        sessionId,
        reason,
        gatewayHealth: "live" as const,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      }));
      const callGateway = fallsBack
        ? createPayloadGatewayMock({ text: "child completion output" })
        : createGatewayMock();
      let activityChecks = 0;
      testing.setDepsForTest({
        callGateway,
        getRequesterSessionActivity: () => ({
          sessionId: "paperclip-session",
          isActive: !activityEnds || activityChecks++ === 0,
        }),
        queueEmbeddedAgentMessageWithOutcome,
        getRuntimeConfig: () => ({ messages: { queue: { mode: "steer" } } }) as never,
      });

      const result = await deliverSubagentAnnouncement({
        requesterSessionKey: "agent:eng:paperclip:issue:123",
        targetRequesterSessionKey: "agent:eng:paperclip:issue:123",
        triggerMessage: "child done",
        steerMessage: "child done",
        ...(fallsBack ? { requesterOrigin: slackThreadOrigin } : {}),
        requesterIsSubagent: false,
        expectsCompletionMessage: false,
        directIdempotencyKey,
      });

      expectRecordFields(result, {
        delivered: fallsBack,
        path: fallsBack ? "direct" : "none",
        ...(fallsBack ? {} : { reason: "steer_dropped" }),
        phases: [
          {
            phase: "steer-primary",
            delivered: false,
            path: "none",
            error: undefined,
            ...(fallsBack ? {} : { reason: "steer_dropped" }),
          },
          ...(fallsBack
            ? [{ phase: "direct-primary", delivered: true, path: "direct", error: undefined }]
            : []),
        ],
      });
      expect(callGateway).toHaveBeenCalledTimes(fallsBack ? 1 : 0);
    },
  );
});

describe("deliverSubagentAnnouncement completion delivery", () => {
  it("uses an active requester queue as the completion handoff when message-tool delivery is not required", async () => {
    const callGateway = createGatewayMock();
    const transcript = await createRequesterTranscriptFixture("requester-session-1");
    const queueEmbeddedAgentMessageWithOutcome = vi.fn<QueueEmbeddedAgentMessageWithOutcome>(
      async (sessionId, _text, options) => {
        await options?.userTurnTranscriptRecorder?.persistApproved();
        return {
          queued: true,
          sessionId,
          target: "embedded_run",
          gatewayHealth: "live",
          enqueuedAtMs: 4_100,
          deliveredAtMs: 4_200,
        };
      },
    );
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      directIdempotencyKey: "announce-1",
      queueEmbeddedAgentMessageWithOutcome,
      requesterTranscriptFixture: transcript,
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
      expect.objectContaining({
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 120_000,
        userTurnTranscriptRecorder: expect.any(Object),
      }),
    );
    expect(callGateway).not.toHaveBeenCalled();

    const rawMessages = await readRequesterTranscriptMessages(transcript);
    expect(rawMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "child done",
        provenance: expect.objectContaining({
          kind: "inter_session",
          sourceTool: "subagent_announce",
        }),
      }),
    ]);
    const assistantReply = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Created." },
        {
          type: "image" as const,
          source: { type: "url" as const, url: "/api/chat/media/outgoing/generated.png" },
        },
      ],
      __openclaw: { seq: 2 },
    };
    expect(
      buildSessionHistorySnapshot({ rawMessages: [...rawMessages, assistantReply] }).history
        .messages,
    ).toEqual([assistantReply]);
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

  it("stops a compacting completion wake when source ownership changes before retry", async () => {
    let sourceEffectsAllowed = true;
    const queueEmbeddedAgentMessageWithOutcome = vi.fn((sessionId: string) => {
      sourceEffectsAllowed = false;
      return {
        queued: false as const,
        sessionId,
        reason: "compacting" as const,
        gatewayHealth: "live" as const,
      };
    });
    const callGateway = createGatewayMock();

    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      directIdempotencyKey: "announce-compaction-source-owner-changed",
      queueEmbeddedAgentMessageWithOutcome,
      isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledOnce();
    expect(callGateway).not.toHaveBeenCalled();
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

  it.each([true, false])(
    "defers completion delivery when sessions_yield owns the handoff (active: %s)",
    async (isActive) => {
      const callGateway = createGatewayMock();
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeSequenceMock([
        "runtime_rejected",
      ]);

      const result = await deliverSlackThreadAnnouncement({
        callGateway,
        sessionId: "requester-session-1",
        isActive,
        directIdempotencyKey: `announce-yield-owned-completion-${isActive}`,
        queueEmbeddedAgentMessageWithOutcome,
        isCompletionOwnedByRequesterYield: () => true,
      });

      expect(result).toMatchObject({
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      });
      expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("fences an active completion delivery when sessions_yield takes ownership mid-wait", async () => {
    let requesterYielded = false;
    let markWakeStarted: () => void = () => undefined;
    const wakeStarted = new Promise<void>((resolve) => {
      markWakeStarted = resolve;
    });
    let releaseWake: () => void = () => undefined;
    const wakeGate = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const queueEmbeddedAgentMessageWithOutcome = vi.fn(async (sessionId: string) => {
      markWakeStarted();
      await wakeGate;
      return {
        queued: true as const,
        sessionId,
        target: "embedded_run" as const,
        gatewayHealth: "live" as const,
        enqueuedAtMs: 4_100,
        deliveredAtMs: 4_200,
      };
    });
    const callGateway = createGatewayMock();

    const delivery = deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      directIdempotencyKey: "announce-yield-owned-mid-wait",
      queueEmbeddedAgentMessageWithOutcome,
      isCompletionOwnedByRequesterYield: () => requesterYielded,
    });
    await wakeStarted;
    requesterYielded = true;
    releaseWake();

    await expect(delivery).resolves.toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
      disposition: "intentional_non_delivery",
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledOnce();
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
      name: "directly delivers direct-message subagent text when the announce agent only reports a tool error",
      payloads: [{ text: "Yield failed before completion.", isError: true }],
      event: { childSessionId: "child-session-id" },
      content: "child completion output",
      fullTarget: true,
      expectsMessageToolMode: true,
    },
    {
      name: "directly delivers direct-message subagent text when the announce agent only emits reasoning",
      payloads: [{ text: "Waiting for the delegated task.", isReasoning: true }],
      event: { childSessionId: "child-session-id" },
      content: "child completion output",
      fullTarget: true,
      expectsMessageToolMode: true,
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

  it.each([
    {
      name: "intentional suppression",
      suppressionReason: "cancelled_by_message_sending_hook",
      disposition: "intentional_non_delivery",
      reason: "delivery_suppressed",
    },
    {
      name: "adapter ambiguity",
      suppressionReason: "adapter_returned_no_identity",
      disposition: "ambiguous",
      reason: undefined,
    },
  ] as const)("reports $name from direct text completion fallback", async (testCase) => {
    const callGateway = createPayloadGatewayMock();
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn(async () => ({
      channel: "discord",
      to: "dm:U123",
      via: "direct" as const,
      mediaUrl: null,
      deliveryStatus: "suppressed" as const,
      suppressionReason: testCase.suppressionReason,
    })) as unknown as typeof runtimeSendMessage;

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      onDeliveryResult,
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      disposition: testCase.disposition,
      reason: testCase.reason,
    });
    expect(onDeliveryResult).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the caller owner for direct completion delivery to a bare requester key", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      requesterSessionKey: "global",
      requesterAgentId: "research",
      runtimeConfig: {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          list: [{ id: "ops" }, { id: "research" }],
        },
      },
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "global",
        agentId: "research",
        mirror: expect.objectContaining({
          sessionKey: "global",
          agentId: "research",
        }),
      }),
    );
  });

  it("sanitizes and bounds text before direct completion fallback delivery", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const leaked = [
      "Visible completion",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "sourceTool: subagent_announce\nsourceId: video_generate:private",
      INTERNAL_RUNTIME_CONTEXT_END,
      "x".repeat(8_000),
    ].join("\n");
    const modelRouteChange = "Model route changed: requested/model → actual/model.";

    await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: leaked,
        modelRouteChange,
      }),
    });

    const content = mockCallArg(sendMessage, 0, 0).content;
    if (typeof content !== "string") {
      throw new Error("expected direct completion text");
    }
    expect(content).toContain("Visible completion");
    expect(content).not.toContain("subagent_announce");
    expect(content).not.toContain("video_generate");
    expect(content).not.toContain(modelRouteChange);
    expect(content.length).toBeLessThanOrEqual(4_096);
  });

  it("reports direct completion delivery before post-send transcript mirroring settles", async () => {
    const callGateway = createPayloadGatewayMock();
    let releaseMirror!: () => void;
    const mirrorPending = new Promise<void>((resolve) => {
      releaseMirror = resolve;
    });
    let resolvePlatformCommit!: () => void;
    const platformCommitted = new Promise<void>((resolve) => {
      resolvePlatformCommit = resolve;
    });
    const onDeliveryResult = vi.fn(() => resolvePlatformCommit());
    const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
      const platformResult = { channel: "discord", messageId: "msg-1" };
      await params.onDeliveryResult?.(platformResult);
      await params.onDeliveryResult?.(platformResult);
      await mirrorPending;
      return {
        channel: "discord",
        to: "dm:U123",
        via: "direct" as const,
        mediaUrl: null,
        result: platformResult,
      };
    }) as unknown as typeof runtimeSendMessage;

    const delivery = deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      onDeliveryResult,
    });
    await platformCommitted;

    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: true, path: "direct", deliveredAt: expect.any(Number) }),
    );
    releaseMirror();
    await expect(delivery).resolves.toMatchObject({ delivered: true, path: "direct" });
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
  });

  it("preserves an identified direct completion when later send bookkeeping fails", async () => {
    const callGateway = createPayloadGatewayMock();
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
      await params.onDeliveryResult?.({ channel: "discord", messageId: "msg-1" });
      throw new Error("post-send bookkeeping failed");
    }) as unknown as typeof runtimeSendMessage;

    const delivery = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      onDeliveryResult,
    });

    expect(delivery).toMatchObject({ delivered: true, path: "direct" });
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers a generic notice for failed subagent placeholder output", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const childSessionKey = "agent:worker:subagent:failed-no-output";

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceSessionKey: childSessionKey,
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        status: "error",
        statusLabel: "failed: all models failed",
        result: "(no output)",
      }),
    });

    expectRecordFields(result, { delivered: true, path: "direct" });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(mockCallArg(sendMessage, 0, 0).content).toBe(
      "A delegated task failed before it could report a result. Please retry the task.",
    );
  });

  it.each(["error", "timeout", "unknown"] as const)(
    "sends one generic direct notice when requester synthesis repeats a %s child completion",
    async (status) => {
      const childSessionKey = `agent:worker:subagent:${status}-child`;
      const providerFailure = "provider rejected private-model-alias with status 400";
      const childResult = "private child output must not reach the requester";
      const callGateway = vi.fn(async () => {
        throw new Error(providerFailure);
      }) as unknown as typeof runtimeCallGateway;
      const sendMessage = createSendMessageMock();

      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
        internalEvents: taskCompletionEvents({
          childSessionKey,
          childSessionId: `${status}-child-session-id`,
          status,
          statusLabel: `${status}: ${providerFailure}`,
          result: childResult,
        }),
      });

      expectRecordFields(result, { delivered: true, path: "direct" });
      expect(callGateway).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledOnce();
      const content = mockCallArg(sendMessage, 0, 0).content;
      expect(content).toBe(
        "A delegated task failed before it could report a result. Please retry the task.",
      );
      expect(content).not.toContain(providerFailure);
      expect(content).not.toContain(childResult);
    },
  );

  it.each(["cancelled", "source owner changed"] as const)(
    "stops a failed-child notice when %s at platform dispatch",
    async (blockedBy) => {
      const childSessionKey = `agent:worker:subagent:${blockedBy.replaceAll(" ", "-")}`;
      const controller = new AbortController();
      let sourceEffectsAllowed = true;
      const platformSend = vi.fn();
      const callGateway = vi.fn(async () => {
        throw new Error("provider rejected requester synthesis");
      }) as unknown as typeof runtimeCallGateway;
      const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
        expect(params.skipQueue).toBe(true);
        expect(params.abortSignal).toBe(controller.signal);
        if (blockedBy === "cancelled") {
          controller.abort();
        } else {
          sourceEffectsAllowed = false;
        }
        await params.onPlatformSendDispatch?.();
        platformSend();
        return {
          channel: "discord",
          to: "dm:U123",
          via: "direct" as const,
          mediaUrl: null,
          result: { messageId: "msg-after-stale-dispatch" },
        };
      }) as unknown as typeof runtimeSendMessage;

      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        signal: controller.signal,
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
        isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
        internalEvents: taskCompletionEvents({
          childSessionKey,
          status: "error",
          statusLabel: "failed before fallback dispatch",
          result: "private child output",
        }),
      });

      expect(result).toMatchObject(
        blockedBy === "cancelled"
          ? { delivered: false, path: "none" }
          : { delivered: false, path: "none", reason: "source_owner_changed", terminal: true },
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(platformSend).not.toHaveBeenCalled();
    },
  );

  it("does not send a failed-child notice for an untrusted event or non-direct target", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("provider rejected requester synthesis");
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();

    const untrusted = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceSessionKey: "agent:worker:subagent:expected-child",
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:worker:subagent:other-child",
        status: "error",
        statusLabel: "failed: provider rejected child run",
        result: "private child output",
      }),
    });
    const nonDirect = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-failed-thread-child",
      sourceSessionKey: "agent:worker:subagent:failed-thread-child",
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:worker:subagent:failed-thread-child",
        status: "error",
        statusLabel: "failed: provider rejected child run",
        result: "private child output",
      }),
    });

    expectRecordFields(untrusted, { delivered: false, path: "direct" });
    expectRecordFields(nonDirect, { delivered: false, path: "direct" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("directly delivers unprefixed direct targets recognized by the channel grammar", async () => {
    registerDirectTargetTestChannel("qa-channel");
    const callGateway = createPayloadGatewayMock();
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
    const callGateway = createPayloadGatewayMock();
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

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
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

  it("delivers dormant child completion under restrictive gateway roles", async () => {
    const callGateway = createGatewayMock();
    const { cfg, dispatchGatewayMethodInProcess } = createRoleRestrictedInProcessGatewayMock({
      result: {
        deliveryStatus: sentDeliveryStatus,
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
      getRuntimeConfig: () => cfg,
    });

    const ownerContext = { owner: "gateway-a" } as never;
    const resolveGatewayContext = () => ownerContext;
    const signal = new AbortController().signal;
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
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:main:subagent:child",
        childSessionId: "child-session-local",
      }),
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-dispatch",
      resolveGatewayContext,
      signal,
    });

    expectDeliveryPath(result, "direct");
    expect(result).toMatchObject({ requesterVisibleFinalDelivered: true });
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
      cancelOnDeadline: true,
      expectFinal: true,
      forceSyntheticClient: true,
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session-local",
        targetSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        targetSessionId: "requester-session-local",
        idempotencyKey: "announce-local-dispatch",
      },
      resolveGatewayContext,
      signal: expect.any(AbortSignal),
    });
  });

  it("wakes settled descendant runs under restrictive gateway roles", async () => {
    const { cfg, dispatchGatewayMethodInProcess } = createRoleRestrictedInProcessGatewayMock({
      runId: "descendant-wake-run",
    });
    const resolveGatewayContext: GatewayContextResolver = () => undefined;
    const signal = new AbortController().signal;
    const replaceSubagentRunAfterSteer = vi.fn(async () => true);
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      loadSessionEntry: () => ({ sessionId: "nested-session", updatedAt: 1 }),
    });

    const woke = await runDescendantWake({
      runId: "nested-parent-run",
      childSessionKey: "agent:main:subagent:nested-parent",
      taskLabel: "collect descendant findings",
      findings: "The descendant completed successfully.",
      announceId: "descendant-completion",
      isChildSessionEffectsAllowed: () => true,
      hasUsableSessionEntry: (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
      resolveGatewayContext,
      signal,
      deps: {
        callGateway: createGatewayMock(),
        dispatchGatewayMethodInProcess,
        getRuntimeConfig: () => cfg,
        replaceSubagentRunAfterSteer,
      },
    });

    expect(woke).toBe(true);
    expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 2)).toMatchObject({
      cancelOnDeadline: true,
      resolveGatewayContext,
      signal,
    });
    expect(replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: "nested-parent-run",
        nextRunId: "descendant-wake-run",
      }),
    );
  });

  it("does not dispatch child-derived completion after source lifecycle ownership changes", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock({
      result: {
        payloads: [{ text: "requester voice completion" }],
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
      requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
      triggerMessage: "child done",
      steerMessage: "child done",
      requesterOrigin: slackThreadOrigin,
      requesterSessionOrigin: slackThreadOrigin,
      completionDirectOrigin: slackThreadOrigin,
      directOrigin: slackThreadOrigin,
      sourceSessionKey: "agent:main:subagent:child",
      internalEvents: taskCompletionEvents({
        childSessionKey: "agent:main:subagent:child",
        childSessionId: "child-session-local",
      }),
      isSourceSessionEffectsAllowed: () => false,
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: "announce-local-dispatch-retired-child",
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no payloads", result: { payloads: [] } },
    {
      name: "only a failed-tool warning",
      result: { payloads: [{ text: "Yield failed before completion.", isError: true }] },
    },
    {
      name: "only hidden reasoning",
      result: { payloads: [{ text: "Waiting for the delegated task.", isReasoning: true }] },
    },
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

  it.each([
    {
      name: "only a failed-tool warning",
      payloads: [{ text: "Yield failed before completion.", isError: true }],
      delivered: false,
    },
    {
      name: "only hidden reasoning",
      payloads: [{ text: "Waiting for the delegated task.", isReasoning: true }],
      delivered: false,
    },
    {
      name: "only pre-tool commentary",
      payloads: [{ text: "Waiting for the delegated task.", isCommentary: true }],
      delivered: false,
    },
    {
      name: "only a compaction notice",
      payloads: [{ text: "Compacting the session.", isCompactionNotice: true }],
      delivered: false,
    },
    {
      name: "only a provider-fallback notice",
      payloads: [{ text: "Switching providers.", isFallbackNotice: true }],
      delivered: false,
    },
    {
      name: "only a transient status notice",
      payloads: [{ text: "Still working.", isStatusNotice: true }],
      delivered: false,
    },
    {
      name: "only supplemental TTS audio",
      payloads: [
        {
          mediaUrl: "file:///tmp/answer.mp3",
          ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true },
        },
      ],
      delivered: false,
    },
    {
      name: "a failed-tool warning and a successful visible reply",
      payloads: [
        { text: "Yield failed before completion.", isError: true },
        { text: "The delegated task completed." },
      ],
      delivered: true,
    },
    {
      name: "hidden reasoning and a successful visible reply",
      payloads: [
        { text: "Waiting for the delegated task.", isReasoning: true },
        { text: "The delegated task completed." },
      ],
      delivered: true,
    },
    {
      name: "a status notice and a successful visible reply",
      payloads: [
        { text: "Still working.", isStatusNotice: true },
        { text: "The delegated task completed." },
      ],
      delivered: true,
    },
  ])(
    "requires a successful visible grouped completion reply when the agent returns $name",
    async ({ payloads, delivered }) => {
      const callGateway = createGatewayMock({
        result: { payloads, ...(delivered ? { deliveryStatus: sentDeliveryStatus } : {}) },
      });
      const result = await deliverSlackThreadAnnouncement({
        callGateway,
        directIdempotencyKey: "announce-thread-completion-payload-visibility",
        sourceTool: "agent_harness_task",
      });

      expectRecordFields(result, {
        delivered,
        path: "direct",
        ...(!delivered
          ? {
              reason: "visible_reply_missing",
              error: "completion agent did not produce a visible reply",
            }
          : {}),
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
        ...committedSessionSpawnEvidence,
      },
    },
    {
      name: "successful cron add",
      result: {
        payloads: [],
        successfulCronAdds: 1,
      },
    },
    {
      name: "a successful visible reply alongside a failed-tool warning",
      result: {
        payloads: [
          { text: "Yield failed before completion.", isError: true },
          { text: "The delegated task completed." },
        ],
      },
    },
    {
      name: "a successful visible reply alongside hidden reasoning",
      result: {
        payloads: [
          { text: "Waiting for the delegated task.", isReasoning: true },
          { text: "The delegated task completed." },
        ],
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

  it("keeps announce-agent delivery primary for dormant completion events with child output", async () => {
    const callGateway = createPayloadGatewayMock({ text: "requester voice completion" });
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
    const callGateway = createPayloadGatewayMock({ text });
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
    const callGateway = createPayloadGatewayMock();
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

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a missing receipt", deliveryStatus: undefined },
    {
      name: "no-visible-payload suppression",
      deliveryStatus: {
        requested: true,
        attempted: false,
        status: "suppressed",
        succeeded: true,
        reason: "no_visible_payload",
        resultCount: 0,
      },
    },
  ])("does not credit stale thread completions after $name", async ({ deliveryStatus }) => {
    const callGateway = createGatewayMock({ result: { payloads: [], deliveryStatus } });
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

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayAgentParams(callGateway, {
      deliver: true,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      threadId: "171.222",
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(3);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenNthCalledWith(
      1,
      "requester-session-4",
      "child done",
      expect.objectContaining({
        debounceMs: 500,
        deliveryTimeoutMs: 120_000,
        steeringMode: "all",
        waitForTranscriptCommit: true,
        userTurnTranscriptRecorder: expect.any(Object),
      }),
    );
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenNthCalledWith(
      2,
      "requester-session-4",
      "child done",
      expect.objectContaining({
        debounceMs: 500,
        deliveryTimeoutMs: 120_000,
        steeringMode: "all",
        userTurnTranscriptRecorder: expect.any(Object),
      }),
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
    const callGateway = createPayloadGatewayMock({ text });
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

  it("keeps synthetic missing output on the generic retry path", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    const childSessionKey = "agent:worker:subagent:empty-success";
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      isActive: true,
      queueEmbeddedAgentMessageWithOutcome,
      sourceSessionKey: childSessionKey,
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        status: "ok",
        statusLabel: "completed successfully",
        result: "(no output)",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      error: "completion agent did not produce a visible reply",
      reason: "visible_reply_missing",
      phases: [
        {
          phase: "direct-primary",
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        },
        {
          phase: "steer-fallback",
          delivered: false,
          path: "none",
          reason: "steer_dropped",
          error: undefined,
        },
      ],
    });
    expect(result.terminal).toBeUndefined();
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("persists fallback-steered completion provenance after the requester session rotates", async () => {
    const previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    try {
      const transcriptA = await createRequesterTranscriptFixture("requester-session-direct");
      const transcriptB = await createRequesterTranscriptFixture("requester-session-fallback");
      let currentTranscript = transcriptA;
      let activityReadCount = 0;
      const callGateway = vi.fn(async () => {
        throw new Error("UNAVAILABLE: gateway lost final output");
      }) as unknown as typeof runtimeCallGateway;
      let firstRecorder: unknown;
      let queueCallCount = 0;
      const queueEmbeddedAgentMessageWithOutcome = vi.fn<QueueEmbeddedAgentMessageWithOutcome>(
        async (sessionId, _text, options) => {
          queueCallCount += 1;
          if (queueCallCount === 1) {
            expect(sessionId).toBe(transcriptA.sessionId);
            firstRecorder = options?.userTurnTranscriptRecorder;
            currentTranscript = transcriptB;
            return {
              queued: false,
              sessionId,
              reason: "not_streaming",
              gatewayHealth: "live",
            };
          }
          expect(sessionId).toBe(transcriptB.sessionId);
          expect(options?.userTurnTranscriptRecorder).not.toBe(firstRecorder);
          await options?.userTurnTranscriptRecorder?.persistApproved();
          return {
            queued: true,
            sessionId,
            target: "embedded_run",
            gatewayHealth: "live",
          };
        },
      );

      const result = await deliverSlackThreadAnnouncement({
        callGateway,
        isActive: true,
        directIdempotencyKey: "announce-retryable-direct-fallback",
        queueEmbeddedAgentMessageWithOutcome,
        requesterSessionActivity: () => ({
          sessionId: activityReadCount++ === 0 ? transcriptA.sessionId : transcriptB.sessionId,
          isActive: true,
        }),
        requesterTranscriptFixture: () => currentTranscript,
        internalEvents: taskCompletionEvents({
          childSessionId: "child-session-id",
          taskLabel: "fallback persistence smoke",
        }),
      });

      expectRecordFields(result, {
        delivered: true,
        path: "steered",
        phases: [
          {
            phase: "direct-primary",
            delivered: false,
            path: "direct",
            error: "UNAVAILABLE: gateway lost final output",
          },
          {
            phase: "steer-fallback",
            delivered: true,
            path: "steered",
            error: undefined,
          },
        ],
      });
      expect(callGateway).toHaveBeenCalledTimes(4);
      expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);

      expect(await readRequesterTranscriptMessages(transcriptA)).toEqual([]);
      const rawMessages = await readRequesterTranscriptMessages(transcriptB);
      expect(rawMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: "child done",
          provenance: expect.objectContaining({
            kind: "inter_session",
            sourceTool: "subagent_announce",
          }),
        }),
      ]);
      const assistantReply = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "visible final reply" }],
        __openclaw: { seq: 2 },
      };
      const history = buildSessionHistorySnapshot({
        rawMessages: [...rawMessages, assistantReply],
      }).history.messages;
      expect(history).toEqual([assistantReply]);
      expect(JSON.stringify(history)).not.toContain("child done");
    } finally {
      if (previousTestFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousTestFast;
      }
    }
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
    const callGateway = createPayloadGatewayMock({ text: "child completion output" });
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
      expect.objectContaining({
        steeringMode: "all",
        debounceMs: 500,
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 10,
        userTurnTranscriptRecorder: expect.any(Object),
      }),
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not restart an abandoned requester session for late completion delivery", async () => {
    const callGateway = createPayloadGatewayMock({ text: "child completion output" });
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
    const callGateway = createPayloadGatewayMock();
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
      path: "steered",
      phases: [
        {
          phase: "direct-primary",
          delivered: false,
          path: "direct",
          error: "completion agent did not produce a visible reply",
          reason: "visible_reply_missing",
        },
        { phase: "steer-fallback", delivered: true, path: "steered", error: undefined },
      ],
    });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(2);
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "image",
      sourceTool: "image_generate",
      attachment: {
        type: "image" as const,
        path: "/tmp/generated-daily.png",
        name: "generated-daily.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        width: 1024,
        height: 768,
      },
      buildEvents: (attachment: NonNullable<AgentInternalEvent["attachments"]>[number]) =>
        imageCompletionEvents({ attachments: [attachment] }),
    },
    {
      name: "music",
      sourceTool: "music_generate",
      attachment: {
        type: "audio" as const,
        path: "/tmp/generated-night-drive.mp3",
        name: "generated-night-drive.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 5678,
        durationMs: 42_000,
      },
      buildEvents: (attachment: NonNullable<AgentInternalEvent["attachments"]>[number]) =>
        musicCompletionEvents({ attachments: [attachment] }),
    },
    {
      name: "video",
      sourceTool: "video_generate",
      attachment: {
        type: "video" as const,
        path: "/tmp/generated-corgi.mp4",
        name: "generated-corgi.mp4",
        mimeType: "video/mp4",
        sizeBytes: 9012,
        durationMs: 8_000,
        width: 1280,
        height: 720,
      },
      buildEvents: (attachment: NonNullable<AgentInternalEvent["attachments"]>[number]) =>
        taskCompletionEvents({
          source: "video_generation",
          childSessionKey: "video_generate:task-123",
          childSessionId: "task-123",
          announceType: "video generation task",
          mediaUrls: [attachment.path ?? ""],
          attachments: [attachment],
        }),
    },
  ])(
    "queues generated $name completions without opt-in or direct delivery",
    async ({ sourceTool, attachment, buildEvents }) => {
      const mediaUrl = attachment.path;
      if (!mediaUrl) {
        throw new Error("generated media fixture requires a path");
      }
      const callGateway = createPayloadGatewayMock();
      const sendMessage = createSendMessageMock();
      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        sourceTool,
        internalEvents: buildEvents(attachment),
      });

      expectDeliveryPath(result, "queued");
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "agentTurn",
          sessionKey: "agent:main:discord:dm:U123",
          inputProvenance: expect.objectContaining({ kind: "inter_session", sourceTool }),
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: [mediaUrl],
          expectedMediaAttachments: { [mediaUrl]: attachment },
          idempotencyKey: "announce-dm-fallback-empty:agent-loop",
        }),
        expect.any(Number),
      );
      expect(sessionDeliveryQueueMocks.releaseSessionDeliveryClaim).toHaveBeenCalledWith(
        "session-delivery-media",
      );
      expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
        "session-delivery-media",
      );
    },
  );

  it("queues generated-media failure notices without raw delivery", async () => {
    const callGateway = createGatewayMock();
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
      internalEvents: musicCompletionEvents({
        status: "error",
        statusLabel: "failed",
        result: "All music generation models failed.",
        mediaUrls: undefined,
      }),
    });

    expectDeliveryPath(result, "queued");
    const queuedPayload =
      sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mock.calls.at(-1)?.[0];
    expect(queuedPayload).toMatchObject({ expectedMediaUrls: [] });
    expect(queuedPayload).not.toHaveProperty("expectedMediaAttachments");
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "fails closed when durable agent-loop persistence is unavailable",
      createCallGateway: () => createPayloadGatewayMock(),
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
      createCallGateway: () => createPayloadGatewayMock(),
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
          throw new Error("gateway persistence failed before agent run");
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
      createCallGateway: () => createPayloadGatewayMock(),
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
      createCallGateway: () => createPayloadGatewayMock(),
      event: {
        childSessionKey: "music_generate:task-empty-success",
        result: "generation completed without a resolved attachment",
        mediaUrls: undefined,
        replyInstruction: "Tell the user the generation completed.",
      },
    },
  ])("$name", async ({ createCallGateway, event, aborted }) => {
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockImplementationOnce(() => {
      throw new Error("state database unavailable");
    });
    const callGateway = createCallGateway();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      signal: aborted ? AbortSignal.abort() : undefined,
      sourceTool: "music_generate",
      internalEvents: musicCompletionEvents(event),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "queued",
      reason: "completion_handoff_unavailable",
      disposition: "retryable",
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not report or replay a dead-lettered durable handoff",
      status: "failed" as const,
      expected: {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_unavailable",
        disposition: "permanent_failure",
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
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockReturnValueOnce({
      id: "session-delivery-media",
      claimed: false,
      status,
    });
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "music_generate",
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
    const callGateway = createPayloadGatewayMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sourceTool: "music_generate",
      signal: controller.signal,
      internalEvents: musicCompletionEvents({
        childSessionKey: "music_generate:task-aborted",
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "queued",
      disposition: "session_queued",
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(sessionDeliveryQueueMocks.releaseSessionDeliveryClaim).toHaveBeenCalledWith(
      "session-delivery-media",
    );
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
  });

  it("stringifies Telegram topic ids for generated video completion handoff", async () => {
    const callGateway = createGatewayMock();
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

    expectDeliveryPath(result, "queued");
    expect(sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          channel: "telegram",
          accountId: "bot-1",
          to: "telegram:-1003970070733",
          threadId: "1",
        }),
        expectedMediaUrls: ["/tmp/generated-corgi.mp4"],
      }),
      expect.any(Number),
    );
    expect(callGateway).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queues generated media group completions that miss required message-tool delivery", async () => {
    const callGateway = createPayloadGatewayMock({
      text: "The track is ready.",
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-media-message-tool",
      sourceTool: "music_generate",
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
      internalEvents: imageCompletionEvents({
        taskLabel: "private proof image",
        result: "Generated 1 image.\nMEDIA:/tmp/generated-private.png",
        mediaUrls: ["/tmp/generated-private.png"],
        replyInstruction: "Tell the user the image is ready and include the generated media.",
      }),
      sourceRunId: "run-generated-media",
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

  it("keeps generated media queued after requester handoff fails", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("requester handoff failed before dispatch");
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
    expect(sessionDeliveryQueueMocks.scheduleSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media",
    );
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

  it("records stale isolated cron run text completions as intentional non-delivery", async () => {
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
      delivered: false,
      path: "none",
      reason: "completion_handoff_pending",
      terminal: true,
      disposition: "intentional_non_delivery",
      phases: [
        {
          phase: "direct-primary",
          delivered: false,
          path: "none",
          reason: "completion_handoff_pending",
          error: undefined,
        },
      ],
    });
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
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

  it("does not credit stale channel completions without a delivery receipt", async () => {
    const callGateway = createPayloadGatewayMock();
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

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rejects missing visible delivery",
      gatewayResult: { payloads: [{ text: "NO_REPLY" }] },
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      },
    },
    {
      name: "blocks replay after committed outbound side effects",
      gatewayResult: {
        payloads: [],
        ...committedSessionSpawnEvidence,
      },
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
        phases: [
          {
            phase: "direct-primary",
            delivered: false,
            path: "direct",
            error: "completion agent did not produce a visible reply",
          },
        ],
      },
    },
    {
      name: "accepts visible parent output after committed outbound side effects",
      gatewayResult: {
        payloads: [{ text: "The delegated task completed." }],
        deliveryStatus: sentDeliveryStatus,
        ...committedSessionSpawnEvidence,
      },
      expected: { delivered: true, path: "direct" },
    },
  ])(
    "$name for automatic no-output channel subagent completions",
    async ({ gatewayResult, expected }) => {
      const callGateway = createGatewayMock({ result: gatewayResult });
      const childSessionKey = "agent:worker:subagent:automatic-no-output";
      const result = await deliverSlackChannelAnnouncement({
        callGateway,
        directIdempotencyKey: "announce-channel-subagent-automatic-no-output",
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
        internalEvents: taskCompletionEvents({
          childSessionKey,
          childSessionId: "child-session-id",
          taskLabel: "channel no-output completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "(no output)",
        }),
      });

      expect(result).toMatchObject(expected);
      expectGatewayAgentParams(callGateway, {
        deliver: true,
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        sourceReplyDeliveryMode: undefined,
      });
    },
  );

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

  it.each([
    {
      route: "configured Slack channel",
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
    },
    {
      route: "forced Discord direct message",
      channel: "discord",
      accountId: "acct-1",
      to: "dm:U123",
    },
  ] as const)(
    "blocks replay for required no-output $route completions with committed outbound side effects",
    async ({ route, channel, accountId, to }) => {
      const callGateway = createGatewayMock({
        result: {
          payloads: [],
          ...committedSessionSpawnEvidence,
        },
      });
      const sendMessage = createSendMessageMock();
      const childSessionKey = "agent:worker:subagent:no-output-side-effect";
      const internalEvents = taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        taskLabel: "no-output side-effect smoke",
        status: "ok",
        statusLabel: "completed successfully",
        result: "(no output)",
      });
      const result =
        route === "configured Slack channel"
          ? await deliverSlackChannelAnnouncement({
              callGateway,
              sendMessage,
              directIdempotencyKey: "announce-channel-subagent-no-output-side-effect",
              sourceTool: "subagent_announce",
              sourceSessionKey: childSessionKey,
              runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
              internalEvents,
            })
          : await deliverDiscordDirectMessageCompletion({
              callGateway,
              sendMessage,
              sourceTool: "subagent_announce",
              sourceSessionKey: childSessionKey,
              internalEvents,
            });

      expectRecordFields(result, {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      });
      expectGatewayAgentParams(callGateway, {
        deliver: false,
        channel,
        accountId,
        to,
        threadId: undefined,
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("fails configured channel subagent completions when parent skips required message tool", async () => {
    const callGateway = createPayloadGatewayMock({ text: "The subagent is done." });
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

  it.each([
    {
      status: "ok",
      statusLabel: "completed successfully",
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      },
    },
    {
      status: "error",
      statusLabel: "failed",
      expected: {
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        error: "completion agent did not use the message tool for message-tool-only delivery",
      },
    },
  ] as const)(
    "fails $status no-output channel subagent completions when parent silently skips required message tool",
    async ({ status, statusLabel, expected }) => {
      const callGateway = createPayloadGatewayMock({ text: "NO_REPLY" });
      const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
      const childSessionKey = "agent:worker:subagent:no-output";
      const result = await deliverSlackChannelAnnouncement({
        callGateway,
        directIdempotencyKey: `announce-channel-subagent-${status}-no-output-message-tool-missing`,
        sourceTool: "subagent_announce",
        sourceSessionKey: childSessionKey,
        runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        queueEmbeddedAgentMessageWithOutcome,
        internalEvents: taskCompletionEvents({
          childSessionKey,
          childSessionId: "child-session-id",
          taskLabel: "channel no-output completion smoke",
          status,
          statusLabel,
          result: "(no output)",
        }),
      });

      expectRecordFields(result, expected);
      expectGatewayAgentParams(callGateway, {
        deliver: false,
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        threadId: undefined,
        sourceReplyDeliveryMode: "message_tool_only",
      });
    },
  );

  it("preserves intentional silence for no-output channel harness completions", async () => {
    const callGateway = createPayloadGatewayMock({ text: "NO_REPLY" });
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    const childSessionKey = "agent:worker:subagent:harness-no-output";
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-channel-harness-no-output-intentional-silence",
      sourceTool: "agent_harness_task",
      sourceSessionKey: childSessionKey,
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      queueEmbeddedAgentMessageWithOutcome,
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        taskLabel: "channel harness no-output completion smoke",
        status: "error",
        statusLabel: "failed",
        result: "(no output)",
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

  it("does not count a different channel target as the requester completion delivery", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:OTHER",
            text: "An unrelated channel update.",
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-subagent-off-target",
      sourceTool: "subagent_announce",
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      reason: "message_tool_delivery_missing",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rejects off-target messaging alone",
      sideEffects: {},
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      },
    },
    {
      name: "blocks replay after an accepted session spawn with off-target messaging",
      sideEffects: committedSessionSpawnEvidence,
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      },
    },
    {
      name: "blocks replay after a successful cron add with off-target messaging",
      sideEffects: { successfulCronAdds: 1 },
      expected: {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      },
    },
  ])("$name for required no-output completion", async ({ sideEffects, expected }) => {
    const childSessionKey = "agent:worker:subagent:off-target-no-output";
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "acct-1",
            to: "channel:OTHER",
            text: "An unrelated channel update.",
          },
        ],
        ...sideEffects,
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      sendMessage,
      directIdempotencyKey: "announce-channel-subagent-off-target-no-output",
      sourceTool: "subagent_announce",
      sourceSessionKey: childSessionKey,
      runtimeConfig: { messages: { groupChat: { visibleReplies: "message_tool" } } },
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "child-session-id",
        taskLabel: "off-target no-output completion smoke",
        status: "ok",
        statusLabel: "completed successfully",
        result: "(no output)",
      }),
    });

    expect(result).toMatchObject(expected);
    expectGatewayAgentParams(callGateway, {
      deliver: false,
      channel: "slack",
      accountId: "acct-1",
      to: "channel:C123",
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers Telegram forum-topic subagent completions through the normal parent handoff", async () => {
    const callGateway = createPayloadGatewayMock({ text: "The delegated task is complete." });

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

  it("records a committed direct completion when the announce turn ends incomplete", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
        deliveryStatus: {
          status: "failed",
          errorMessage: "Agent couldn't generate a response.",
        },
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            text: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
            sourceReplyFinal: true,
          },
        ],
      },
    });
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "(no output)",
      }),
    });

    expectDeliveryPath(result, "direct");
  });

  it.each([
    {
      name: "accepts message delivery to the requester",
      target: { provider: "discord", accountId: "acct-1", to: "dm:U123" },
      fallsBack: false,
    },
    {
      name: "accepts legacy targetless delivery on the requester provider",
      target: { provider: "message" },
      fallsBack: false,
    },
    {
      name: "repairs a completion sent to another recipient",
      target: { provider: "discord", accountId: "acct-1", to: "dm:OTHER" },
      fallsBack: true,
    },
    {
      name: "repairs a targetless completion sent through another provider",
      target: { provider: "slack" },
      fallsBack: true,
    },
    {
      name: "repairs a completion sent through another requester account",
      target: { provider: "discord", accountId: "acct-other", to: "dm:U123" },
      fallsBack: true,
    },
    {
      name: "preserves authoritative source delivery alongside an unrelated send",
      target: { provider: "discord", accountId: "acct-1", to: "dm:OTHER" },
      didDeliverSourceReplyViaMessageTool: true,
      fallsBack: false,
    },
    {
      name: "preserves targetless source media alongside an unrelated targeted send",
      target: {
        provider: "discord",
        accountId: "acct-1",
        to: "dm:OTHER",
        mediaUrls: ["/tmp/unrelated.mp3"],
      },
      messagingToolSentMediaUrls: ["/tmp/current-source.mp3"],
      fallsBack: false,
    },
    {
      name: "does not mistake an off-target attachment for targetless source media",
      target: {
        provider: "discord",
        accountId: "acct-1",
        to: "dm:OTHER",
        mediaUrls: ["/tmp/off-target.mp3"],
      },
      messagingToolSentMediaUrls: ["/tmp/off-target.mp3"],
      fallsBack: true,
    },
  ])(
    "$name",
    async ({
      target,
      didDeliverSourceReplyViaMessageTool,
      messagingToolSentMediaUrls,
      fallsBack,
    }) => {
      const callGateway = createGatewayMock({
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          ...(didDeliverSourceReplyViaMessageTool ? { didDeliverSourceReplyViaMessageTool } : {}),
          ...(messagingToolSentMediaUrls ? { messagingToolSentMediaUrls } : {}),
          messagingToolSentTargets: [
            { tool: "message", ...target, text: "The subagent is done: child completion output" },
          ],
        },
      });
      const sendMessage = createSendMessageMock();
      const result = await deliverDiscordDirectMessageCompletion({
        callGateway,
        sendMessage,
        sourceTool: "subagent_announce",
        internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      });

      expectDeliveryPath(result, "direct");
      if (fallsBack) {
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "discord",
            accountId: "acct-1",
            to: "dm:U123",
            content: "child completion output",
          }),
        );
      } else {
        expect(sendMessage).not.toHaveBeenCalled();
      }
    },
  );

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
    const callGateway = createPayloadGatewayMock({ text: "child completion output" });
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

  it.each([
    {
      name: "suppressed",
      deliveryStatus: {
        status: "suppressed",
        resultCount: 0,
        reason: "cancelled_by_message_sending_hook",
      },
      expected: {
        delivered: false,
        disposition: "intentional_non_delivery",
        reason: "delivery_suppressed",
        error: "cancelled_by_message_sending_hook",
      },
    },
    {
      name: "channel-transformed",
      payloads: [],
      deliveryStatus: {
        status: "suppressed",
        attempted: false,
        resultCount: 0,
        reason: "channel_transform",
      },
      expected: {
        delivered: false,
        disposition: "intentional_non_delivery",
        reason: "delivery_suppressed",
        error: "channel_transform",
      },
    },
    ...[
      ["adapter_returned_no_identity"],
      ["cancelled_by_message_sending_hook", "adapter_returned_no_identity"],
      ["no_visible_payload", "adapter_returned_no_identity"],
    ].map((reasons) => ({
      name: `unidentified adapter after ${reasons[0]}`,
      payloads: reasons.map((_, index) => ({ text: `Generated completion ${index}` })),
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "suppressed",
        succeeded: true,
        resultCount: 0,
        reason: reasons[0],
        payloadOutcomes: reasons.map((reason, index) => ({
          index,
          status: "suppressed",
          reason,
        })),
      },
      expected: {
        delivered: false,
        disposition: "ambiguous",
      },
    })),
    {
      name: "empty output before a hook cancellation",
      payloads: [{ text: "" }, { text: "Cancelled completion" }],
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "suppressed",
        succeeded: true,
        resultCount: 0,
        reason: "no_visible_payload",
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "no_visible_payload" },
          { index: 1, status: "suppressed", reason: "cancelled_by_message_sending_hook" },
        ],
      },
      expected: {
        delivered: false,
        disposition: "intentional_non_delivery",
        reason: "delivery_suppressed",
        error: "cancelled_by_message_sending_hook",
      },
    },
    ...["adapter_returned_no_identity", "cancelled_by_message_sending_hook"].map((reason) => ({
      name: `source progress before ${reason}`,
      sourceProgress: true,
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "suppressed",
        succeeded: true,
        resultCount: 0,
        reason,
        payloadOutcomes: [{ index: 0, status: "suppressed", reason }],
      },
      expected:
        reason === "adapter_returned_no_identity"
          ? { delivered: false, disposition: "ambiguous" }
          : {
              delivered: false,
              disposition: "intentional_non_delivery",
              reason: "delivery_suppressed",
              error: reason,
            },
    })),
    {
      name: "unidentified adapter before a later failure",
      payloads: [{ text: "Unidentified completion" }, { text: "Failed supplement" }],
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "failed",
        succeeded: false,
        error: true,
        errorMessage: "supplement failed",
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          {
            index: 1,
            status: "failed",
            sentBeforeError: false,
            stage: "platform_send",
            error: "supplement failed",
          },
        ],
      },
      expected: {
        delivered: false,
        disposition: "ambiguous",
      },
    },
    {
      name: "partial send without per-payload details",
      deliveryStatus: {
        requested: true,
        attempted: true,
        status: "partial_failed",
        succeeded: "partial",
        resultCount: 1,
        sentBeforeError: true,
        error: true,
        errorMessage: "supplement failed",
      },
      expected: {
        delivered: false,
        disposition: "ambiguous",
      },
    },
    { name: "missing", deliveryStatus: undefined },
    { name: "empty", deliveryStatus: { status: "sent", resultCount: 0 } },
  ])("does not credit a $name automatic completion receipt", async (testCase) => {
    const { deliveryStatus, expected } = testCase;
    const payloads = "payloads" in testCase ? testCase.payloads : undefined;
    const sourceProgress = "sourceProgress" in testCase && testCase.sourceProgress;
    const callGateway = createGatewayMock({
      result: {
        payloads: payloads ?? [{ text: "Generated completion" }],
        deliveryStatus,
        ...(sourceProgress
          ? {
              didSendViaMessagingTool: true,
              messagingToolSentTargets: [
                {
                  tool: "message",
                  provider: "slack",
                  accountId: "acct-1",
                  to: "channel:C123",
                  threadId: "171.222",
                  text: "Work is in progress",
                  sourceReplyFinal: false,
                },
              ],
            }
          : {}),
      },
    });
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(false);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      queueEmbeddedAgentMessageWithOutcome,
      directIdempotencyKey: "announce-undelivered-receipt",
    });

    expect(result).toMatchObject(
      expected ?? {
        delivered: false,
        reason: "visible_reply_missing",
      },
    );
    expect(result.requesterVisibleFinalDelivered).toBeUndefined();
    if (expected?.disposition === "ambiguous") {
      expect(result.reason).toBeUndefined();
      expect(result.terminal).toBeUndefined();
    }
    if (deliveryStatus?.status === "suppressed" || expected?.disposition === "ambiguous") {
      expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    }
  });

  const requesterSettleSourceTarget = {
    tool: "message",
    provider: "discord",
    accountId: "acct-1",
    to: "dm:U123",
    text: "the consolidated answer",
  } as const;

  it("does not credit saved completion text when the external destination is missing", async () => {
    const callGateway = createGatewayMock({
      result: { payloads: [{ text: "Generated completion" }] },
    });
    testing.setDepsForTest({
      callGateway,
      getRuntimeConfig: () => ({}) as never,
      getRequesterSessionActivity: () => ({ isActive: false }),
      queueEmbeddedAgentMessageWithOutcome: createQueueOutcomeMock(false),
    });
    const origin = { channel: "slack" };
    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: "agent:main:announce-missing-destination",
      targetRequesterSessionKey: "agent:main:announce-missing-destination",
      requesterOrigin: origin,
      requesterSessionOrigin: origin,
      directOrigin: origin,
      requesterIsSubagent: false,
      expectsCompletionMessage: true,
      triggerMessage: "worker completed",
      steerMessage: "worker completed",
      directIdempotencyKey: "announce-missing-destination",
    });

    expect(result).toMatchObject({ delivered: false, reason: "visible_reply_missing" });
    expectGatewayAgentParams(callGateway, { deliver: false, channel: "slack", to: undefined });
  });

  const deliveredRequesterFinal = { delivered: true, path: "direct" } as const;
  const missingRequesterFinal = {
    delivered: false,
    path: "direct",
    reason: "visible_reply_missing",
  } as const;

  const externalRequesterSettleRoute = {
    name: "Discord",
    sessionKey: "agent:main:discord:dm:U123",
    origin: { channel: "discord", to: "dm:U123", accountId: "acct-1" },
    agentParams: { deliver: true, channel: "discord", accountId: "acct-1", to: "dm:U123" },
  };
  const requesterSettleRoutes = [
    externalRequesterSettleRoute,
    {
      name: "no origin",
      sessionKey: "agent:main:requester-settle",
      origin: undefined,
      agentParams: { deliver: false, channel: undefined, accountId: undefined, to: undefined },
    },
    {
      name: "WebChat",
      sessionKey: "agent:main:webchat:dm:requester-settle",
      origin: { channel: "webchat" },
      agentParams: { deliver: false, channel: "webchat", accountId: undefined, to: undefined },
    },
    {
      name: "nested requester with inherited Discord origin",
      sessionKey: "agent:main:subagent:requester-settle",
      origin: externalRequesterSettleRoute.origin,
      requesterIsSubagent: true,
      agentParams: { deliver: false, channel: undefined, accountId: undefined, to: undefined },
    },
  ];

  const requesterSettleCases = [
    {
      name: "preserves an ordinary non-yielded direct settle turn",
      response: {},
      requireVisibleReply: false,
      expected: deliveredRequesterFinal,
    },
    {
      name: "preserves an intentional silent non-yielded settle turn",
      response: { result: { payloads: [{ text: "NO_REPLY" }] } },
      requireVisibleReply: false,
      expected: deliveredRequesterFinal,
    },
    {
      name: "accepts a yielded requester's visible final answer",
      routes: requesterSettleRoutes.slice(1),
      response: { result: { payloads: [{ text: "The consolidated answer." }] } },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "accepts a yielded requester's delivered external final answer",
      response: {
        result: {
          payloads: [{ text: "The consolidated answer." }],
          deliveryStatus: sentDeliveryStatus,
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "accepts a yielded requester final already committed by automatic delivery",
      response: {
        result: {
          payloads: [],
          deliveryStatus: { status: "sent", succeeded: true, resultCount: 1 },
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "rejects a yielded turn without a result",
      routes: requesterSettleRoutes,
      response: {},
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a yielded turn with no response payloads",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a yielded turn that emits only an error",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "tool failed", isError: true }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a yielded turn that emits only private reasoning",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "thinking", isReasoning: true }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects pre-tool commentary instead of a final answer",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "working on it", isCommentary: true }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a compaction notice instead of a final answer",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "compacting", isCompactionNotice: true }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a provider-fallback notice instead of a final answer",
      routes: requesterSettleRoutes,
      response: {
        result: { payloads: [{ text: "switching providers", isFallbackNotice: true }] },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a transient status notice instead of a final answer",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "still working", isStatusNotice: true }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects supplemental TTS audio instead of a final answer",
      routes: requesterSettleRoutes,
      response: {
        result: {
          payloads: [
            {
              mediaUrl: "file:///tmp/answer.mp3",
              ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true },
            },
          ],
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "preserves a visible answer with malformed supplemental media metadata",
      response: {
        result: {
          deliveryStatus: sentDeliveryStatus,
          payloads: [
            { text: "The real answer.", mediaUrl: 1, ttsSupplement: { spokenText: "answer" } },
          ],
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "rejects an explicitly hidden assistant payload",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "not user visible", visible: false }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a yielded turn that emits only the silent reply token",
      routes: requesterSettleRoutes,
      response: { result: { payloads: [{ text: "NO_REPLY" }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a visible final whose delivery was suppressed",
      routes: requesterSettleRoutes.slice(1),
      response: {
        result: {
          payloads: [{ text: "never delivered" }],
          deliveryStatus: { status: "suppressed", succeeded: true, resultCount: 0 },
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "records a suppressed external final without retry",
      response: {
        result: {
          payloads: [{ text: "never delivered" }],
          deliveryStatus: { status: "suppressed", resultCount: 0 },
        },
      },
      requireVisibleReply: true,
      expected: {
        delivered: false,
        disposition: "intentional_non_delivery",
        reason: "delivery_suppressed",
      },
    },
    {
      name: "rejects an empty successful automatic delivery receipt",
      response: {
        result: {
          payloads: [],
          deliveryStatus: { status: "sent", succeeded: true, resultCount: 0 },
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a malformed automatic delivery receipt",
      response: {
        result: {
          payloads: [],
          deliveryStatus: { status: "sent", succeeded: true, resultCount: "1" },
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a messaging-tool flag without a committed source receipt",
      response: { result: { payloads: [], didSendViaMessagingTool: true } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects messaging aggregates without a source-matched receipt",
      response: {
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["sent somewhere else"],
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects an accepted subagent spawn without a final reply",
      response: {
        result: {
          payloads: [],
          acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:main:child" }],
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a cron side effect without a final reply",
      response: { result: { payloads: [], successfulCronAdds: 1 } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a source-matched messaging progress update",
      response: {
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [{ ...requesterSettleSourceTarget, sourceReplyFinal: false }],
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "rejects a final message sent to another recipient",
      response: {
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [
            { ...requesterSettleSourceTarget, to: "dm:OTHER", sourceReplyFinal: true },
          ],
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "does not let an off-target final upgrade source progress",
      response: {
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [
            { ...requesterSettleSourceTarget, sourceReplyFinal: false },
            { ...requesterSettleSourceTarget, to: "dm:OTHER", sourceReplyFinal: true },
          ],
        },
      },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
    {
      name: "accepts an explicit source-matched final messaging delivery",
      response: {
        result: {
          payloads: [{ text: "NO_REPLY" }],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [{ ...requesterSettleSourceTarget, sourceReplyFinal: true }],
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "accepts an automatic source-matched final without legacy intent markers",
      response: {
        result: {
          payloads: [{ text: "NO_REPLY" }],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [requesterSettleSourceTarget],
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "accepts a source final after source progress in the same turn",
      response: {
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [
            { ...requesterSettleSourceTarget, sourceReplyFinal: false },
            { ...requesterSettleSourceTarget, sourceReplyFinal: true },
          ],
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "accepts a committed source final when automatic delivery was suppressed",
      response: {
        result: {
          payloads: [{ text: "NO_REPLY" }],
          deliveryStatus: { status: "suppressed", succeeded: true, resultCount: 0 },
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [{ ...requesterSettleSourceTarget, sourceReplyFinal: true }],
        },
      },
      requireVisibleReply: true,
      expected: deliveredRequesterFinal,
    },
    {
      name: "rejects terminal text when an external origin cannot be resolved",
      routes: [
        {
          name: "external channel without destination",
          sessionKey: "agent:main:requester-settle",
          origin: { channel: "discord" },
          agentParams: {
            deliver: false,
            channel: "discord",
            accountId: undefined,
            to: undefined,
          },
        },
        {
          name: "destination without channel",
          sessionKey: "agent:main:requester-settle",
          origin: { to: "dm:U123" },
          agentParams: {
            deliver: false,
            channel: undefined,
            accountId: undefined,
            to: undefined,
          },
        },
        {
          name: "unknown channel",
          sessionKey: "agent:main:requester-settle",
          origin: { channel: "unknown-external", to: "dm:U123" },
          agentParams: {
            deliver: false,
            channel: undefined,
            accountId: undefined,
            to: undefined,
          },
        },
      ],
      response: { result: { payloads: [{ text: "The consolidated answer." }] } },
      requireVisibleReply: true,
      expected: missingRequesterFinal,
    },
  ];

  it.each(
    requesterSettleCases.flatMap((testCase) =>
      (testCase.routes ?? [externalRequesterSettleRoute]).map((route) => ({
        testCase,
        route,
      })),
    ),
  )("$route.name: $testCase.name", async ({ testCase, route }) => {
    const { response, requireVisibleReply, expected } = testCase;
    const callGateway = createGatewayMock(response);
    const queueEmbeddedAgentMessageWithOutcome = createQueueOutcomeMock(true);
    const sendMessage = createSendMessageMock();
    const origin = route.origin;
    testing.setDepsForTest({
      callGateway,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session-dm",
        isActive: true,
      }),
      getRuntimeConfig: () => ({}) as never,
      queueEmbeddedAgentMessageWithOutcome,
      sendMessage,
    });

    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: route.sessionKey,
      targetRequesterSessionKey: route.sessionKey,
      triggerMessage: "all spawned subagents settled",
      steerMessage: "all spawned subagents settled",
      requesterOrigin: origin,
      requesterSessionOrigin: origin,
      directOrigin: origin,
      requesterIsSubagent: "requesterIsSubagent" in route && route.requesterIsSubagent === true,
      expectsCompletionMessage: false,
      requireDirectDelivery: true,
      ...(requireVisibleReply ? { requireVisibleReply: true } : {}),
      directIdempotencyKey: "announce-requester-settle-direct",
      sourceTool: "subagent_announce",
    });

    expect(result).toMatchObject(expected);
    expect(result.requesterVisibleFinalDelivered).toBeUndefined();
    expect(queueEmbeddedAgentMessageWithOutcome).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const agentParams = expectGatewayAgentParams(callGateway, route.agentParams);
    expect(agentParams.sourceReplyDeliveryMode).toBe(
      requireVisibleReply && route.agentParams.deliver ? "automatic" : undefined,
    );
  });

  it.each([
    {
      name: "a transient network cause wrapped by outbound delivery",
      createError: () =>
        new Error("outbound delivery failed", { cause: new Error("connect ECONNRESET") }),
    },
    {
      name: "a transient network cause nested through multiple delivery wrappers",
      createError: () =>
        new Error("requester handoff failed", {
          cause: new Error("outbound delivery failed", {
            cause: new Error("connect ECONNREFUSED"),
          }),
        }),
    },
  ])("retries $name before any platform send", async ({ createError }) => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(createError())
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "recovered child completion" }],
          deliveryStatus: sentDeliveryStatus,
        },
      });

    const result = await deliverSlackChannelAnnouncement({
      callGateway: callGateway as typeof runtimeCallGateway,
      directIdempotencyKey: "announce-wrapped-transient-retry",
    });

    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("runs the full retry schedule for a typed adapter-resolution failure", async () => {
    const adapterUnavailable = new PlatformMessageNotDispatchedError(
      "Outbound not configured for channel: slack",
      { cause: new Error("adapter unavailable") },
    );
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(adapterUnavailable)
      .mockRejectedValueOnce(adapterUnavailable)
      .mockRejectedValueOnce(adapterUnavailable)
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "recovered child completion" }],
          deliveryStatus: sentDeliveryStatus,
        },
      });

    const result = await deliverSlackChannelAnnouncement({
      callGateway: callGateway as typeof runtimeCallGateway,
      directIdempotencyKey: "announce-adapter-resolution-retry",
    });

    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expect(callGateway).toHaveBeenCalledTimes(4);
  });

  it("keeps an exhausted typed adapter-resolution failure retryable", async () => {
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw new PlatformMessageNotDispatchedError("Outbound not configured for channel: slack", {
        cause: new Error("adapter unavailable"),
      });
    });

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-adapter-resolution-exhausted",
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      disposition: "retryable",
    });
    expect(callGateway).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      name: "a wrapped permanent channel failure",
      createError: () =>
        new Error("outbound delivery failed", { cause: new Error("chat not found") }),
    },
    {
      name: "a typed permanent platform rejection",
      createError: () =>
        new PlatformMessageNotDispatchedError("payload rejected by platform policy", {
          cause: new Error("payload cannot be delivered"),
          retryable: false,
        }),
    },
    {
      name: "a wrapped typed permanent rejection with a transient-looking cause",
      createError: () =>
        new Error("outbound delivery failed", {
          cause: new PlatformMessageNotDispatchedError("payload rejected by platform policy", {
            cause: new Error("connect ECONNRESET"),
            retryable: false,
          }),
        }),
    },
  ])("classifies $name as a permanent failure", async ({ createError }) => {
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw createError();
    });

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-wrapped-permanent-rejection",
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      disposition: "permanent_failure",
    });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "an identified outbound platform send",
      createError: () =>
        new OutboundDeliveryError("connect ECONNRESET", {
          cause: new Error("connect ECONNRESET"),
          results: [{ channel: "telegram", messageId: "msg-already-sent" }],
        }),
    },
    {
      name: "a nested visible reply receipt",
      createError: () =>
        new Error("connect ECONNRESET", {
          cause: Object.assign(new Error("platform send completed"), {
            visibleReplySent: true,
          }),
        }),
    },
  ])("never retries a transient error after $name", async ({ createError }) => {
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw createError();
    });

    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-transient-after-confirmed-send",
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      disposition: "ambiguous",
    });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("does not retry writer-claim rebound failures with send evidence", async () => {
    const sendErr = new OutboundDeliveryError("outbound delivery failed", {
      cause: new Error("outbound delivery failed"),
      results: [{ channel: "telegram", messageId: "msg-1" }],
    });
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw Object.assign(
        new Error("session writer claim changed before transcript persistence", {
          cause: sendErr,
        }),
        { name: "SessionTranscriptWriterClaimReboundError" },
      );
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
    expect(result.disposition).toBe("ambiguous");
    expect(result.phases?.map((phase) => phase.phase)).toEqual(["direct-primary"]);
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledTimes(1);
  });

  it("retries writer-claim rebound failures without send evidence", async () => {
    let attempts = 0;
    const callGatewaySpy = vi.fn();
    const callGateway: typeof runtimeCallGateway = async <
      T = Record<string, unknown>,
    >(): Promise<T> => {
      callGatewaySpy();
      attempts++;
      if (attempts <= 1) {
        throw Object.assign(
          new Error("session writer claim changed before transcript persistence"),
          { name: "SessionTranscriptWriterClaimReboundError" },
        );
      }
      return {
        result: {
          payloads: [{ text: "recovered after retry" }],
          deliveryStatus: sentDeliveryStatus,
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

  it("stops a direct Gateway retry when source ownership changes after the first attempt", async () => {
    let sourceEffectsAllowed = true;
    const callGatewaySpy = vi.fn();
    const callGateway: typeof runtimeCallGateway = async <
      T = Record<string, unknown>,
    >(): Promise<T> => {
      callGatewaySpy();
      sourceEffectsAllowed = false;
      throw new Error("gateway not connected");
    };
    const result = await deliverSlackChannelAnnouncement({
      callGateway,
      directIdempotencyKey: "announce-retry-source-owner-changed",
      isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
    expect(callGatewaySpy).toHaveBeenCalledOnce();
  });

  it("does not text-fallback when source ownership changes during the Gateway attempt", async () => {
    let sourceEffectsAllowed = true;
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      sourceEffectsAllowed = false;
      throw new Error("incomplete terminal response code=incomplete_result");
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();
    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
      isSourceSessionEffectsAllowed: () => sourceEffectsAllowed,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      terminal: true,
    });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not text-fallback after an identified incomplete platform send", async () => {
    const callGateway: typeof runtimeCallGateway = vi.fn(async () => {
      throw new OutboundDeliveryError("incomplete terminal response", {
        cause: new Error("incomplete terminal response"),
        results: [{ channel: "discord", messageId: "already-sent" }],
      });
    });
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expect(result).toMatchObject({ delivered: false, path: "direct", disposition: "ambiguous" });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("detects send evidence from OutboundDeliveryError in a writer rebound chain", () => {
    const err = Object.assign(
      new Error("session writer claim changed before transcript persistence", {
        cause: new OutboundDeliveryError("outbound delivery failed", {
          cause: new Error("outbound delivery failed"),
          results: [{ channel: "telegram", messageId: "msg-1" }],
        }),
      }),
      { name: "SessionTranscriptWriterClaimReboundError" },
    );

    expect(testing.isWriterClaimReboundAnnounceError(err)).toBe(true);
    expect(testing.hasAnnounceSendEvidence(err)).toBe(true);
  });

  it("classifies writer rebound without send markers as no-send-evidence", () => {
    const err = Object.assign(
      new Error("session writer claim changed before transcript persistence"),
      { name: "SessionTranscriptWriterClaimReboundError" },
    );

    expect(testing.isWriterClaimReboundAnnounceError(err)).toBe(true);
    expect(testing.hasAnnounceSendEvidence(err)).toBe(false);
  });

  it("detects send evidence from visibleReplySent on writer rebound", () => {
    const err = Object.assign(
      new Error("session writer claim changed before transcript persistence"),
      { name: "SessionTranscriptWriterClaimReboundError", visibleReplySent: true },
    );

    expect(testing.hasAnnounceSendEvidence(err)).toBe(true);
  });

  it("detects send evidence from sentBeforeError on writer rebound", () => {
    const err = Object.assign(
      new Error("session writer claim changed before transcript persistence"),
      { name: "SessionTranscriptWriterClaimReboundError", sentBeforeError: true },
    );

    expect(testing.hasAnnounceSendEvidence(err)).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
