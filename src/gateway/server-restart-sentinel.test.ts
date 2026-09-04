// Restart sentinel tests protect queued post-restart delivery recovery and the
// session/channel context used when the gateway resumes an interrupted run.
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { resolveSystemEventOptionsOwnerAgentId } from "../infra/system-event-ownership.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";

type RestartSentinel = NonNullable<
  Awaited<ReturnType<typeof import("../infra/restart-sentinel.js").readRestartSentinel>>
>;

type LoadedSessionEntryBase = ReturnType<typeof import("./session-utils.js").loadSessionEntry>;
type LoadedSessionEntry = Omit<LoadedSessionEntryBase, "agentId"> &
  Partial<Pick<LoadedSessionEntryBase, "agentId">>;
type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof import("../channels/turn/lifecycle.js").dispatchAssembledChannelTurn
>[0] & {
  deliver: (payload: { text?: string; replyToId?: string | null }) => Promise<void>;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};
type InProcessDispatchMock = (
  method: string,
  params: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type AdvanceSessionDeliveryAgentRunMock =
  typeof import("../infra/session-delivery-queue-storage.js").advanceSessionDeliveryAgentRun;
type DeferSessionDeliveryMock =
  typeof import("../infra/session-delivery-queue-storage.js").deferSessionDelivery;
type FailSessionDeliveryMock =
  typeof import("../infra/session-delivery-queue-storage.js").failSessionDelivery;
type MergeSessionDeliveryPreparedMediaBlocksMock =
  typeof import("../infra/session-delivery-queue-storage.js").mergeSessionDeliveryPreparedMediaBlocks;
type RecoverPendingSessionDeliveriesMock =
  typeof import("../infra/session-delivery-queue-recovery.js").recoverPendingSessionDeliveries;
type DrainPendingSessionDeliveryMock =
  typeof import("../infra/session-delivery-queue-recovery.js").drainPendingSessionDelivery;
type AppendAssistantMessageToSessionTranscriptMock =
  typeof import("../config/sessions/transcript.js").appendAssistantMessageToSessionTranscript;
type CreateManagedOutgoingMediaBlocksMock =
  typeof import("./managed-image-attachments.js").createManagedOutgoingMediaBlocks;
type AttachManagedOutgoingMediaToMessageMock =
  typeof import("./managed-image-attachments.js").attachManagedOutgoingMediaToMessage;

const mocks = vi.hoisted(() => {
  const state = {
    initialOutboundDelivery: null as Record<string, unknown> | null,
  };

  return {
    resolveSessionAgentId: vi.fn(() => "agent-from-key"),
    setInitialOutboundDelivery(value: Record<string, unknown> | null) {
      state.initialOutboundDelivery = value;
    },
    takeInitialOutboundDelivery() {
      const value = state.initialOutboundDelivery;
      state.initialOutboundDelivery = null;
      return value;
    },
    dispatchGatewayMethodInProcess: vi.fn<InProcessDispatchMock>(async () => ({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "sent" },
      },
    })),
    readRestartSentinel: vi.fn(async (): Promise<RestartSentinel> => ({
      version: 1,
      revision: 123,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 123,
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      },
    })),
    finalizeUpdateRestartSentinelRunningVersion: vi.fn(async () => null),
    clearRestartSentinelIfRevision: vi.fn(async () => true),
    formatRestartSentinelMessage: vi.fn(() => "restart message"),
    summarizeRestartSentinel: vi.fn(() => "restart summary"),
    resolveSystemMainSessionTarget: vi.fn(() => ({
      agentId: "ops",
      sessionKey: "agent:ops:main",
    })),
    parseSessionThreadInfo: vi.fn(
      (): { baseSessionKey: string | null | undefined; threadId: string | undefined } => ({
        baseSessionKey: null,
        threadId: undefined,
      }),
    ),
    loadSessionEntry: vi.fn<(sessionKey: string) => LoadedSessionEntry>((sessionKey) => ({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: sessionKey,
        updatedAt: 0,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
    })),
    deliveryContextFromSession: vi.fn<
      typeof import("../utils/delivery-context.shared.js").deliveryContextFromSession
    >(() => undefined),
    mergeDeliveryContext: vi.fn((a?: Record<string, unknown>, b?: Record<string, unknown>) => ({
      ...b,
      ...a,
    })),
    getChannelPlugin: vi.fn((): ChannelPlugin | undefined => undefined),
    normalizeChannelId: vi.fn<(channel?: string | null) => string | null>(),
    resolveOutboundTarget: vi.fn(((_params?: { to?: string }) => ({
      ok: true as const,
      to: "+15550002",
    })) as (params?: { to?: string }) => { ok: true; to: string } | { ok: false; error: Error }),
    deliverOutboundPayloads: vi.fn(async (_params?: Record<string, unknown>) => [
      { channel: "whatsapp", messageId: "msg-1" },
    ]),
    enqueueDeliveryOnce: vi.fn(async (_payload: unknown, id: string) => ({ id, created: true })),
    findDeliveryIntentOwner: vi.fn<
      () => {
        namespace: "prepared" | "preparing" | "migration" | "legacy-preparing" | "legacy";
        status: "pending" | "failed" | "completed";
      } | null
    >(() => null),
    ackDelivery: vi.fn(async () => {}),
    failDelivery: vi.fn(async () => {}),
    failDeliveryAfterPlatformSend: vi.fn(async () => {}),
    failDeliveryBeforePlatformSend: vi.fn(async () => {}),
    failPendingDelivery: vi.fn(async () => ({ status: "failed" as const })),
    loadPendingDelivery: vi.fn(async () => null),
    drainPendingDeliveries: vi.fn(async () => {}),
    reserveDeliveryAttempt: vi.fn(async () => ({
      status: "reserved" as const,
      attemptCount: 1,
    })),
    withActiveDeliveryClaim: vi.fn(async (_id: string, fn: () => Promise<unknown>) => ({
      status: "claimed" as const,
      value: await fn(),
    })),
    withStableDeliveryPreparation: vi.fn(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    enqueueSessionDelivery: vi.fn(),
    advanceSessionDeliveryAgentRun: vi.fn<AdvanceSessionDeliveryAgentRunMock>(async () => {}),
    deferSessionDelivery: vi.fn<DeferSessionDeliveryMock>(async () => {}),
    failSessionDelivery: vi.fn<FailSessionDeliveryMock>(async () => {}),
    mergeSessionDeliveryPreparedMediaBlocks: vi.fn<MergeSessionDeliveryPreparedMediaBlocksMock>(
      async (_id, _mediaUrl, blocks) => blocks,
    ),
    markSessionDeliveryAttemptStarted: vi.fn(async () => {}),
    markSessionDeliverySettlement: vi.fn(async () => {}),
    appendAssistantMessageToSessionTranscript: vi.fn<AppendAssistantMessageToSessionTranscriptMock>(
      async () => ({
        ok: true as const,
        target: {
          agentId: "main",
          sessionId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        messageId: "generated-media-transcript",
      }),
    ),
    createManagedOutgoingMediaBlocks: vi.fn<CreateManagedOutgoingMediaBlocksMock>(async (params) =>
      (params.items ?? []).map((item) => ({
        type: item.mimeType?.startsWith("audio/") ? "audio" : "image",
        artifactId: `artifact:${item.url}`,
        url: `/api/chat/media/outgoing/${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(item.url)}/full`,
        openUrl: `/api/chat/media/outgoing/${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(item.url)}/full`,
      })),
    ),
    attachManagedOutgoingMediaToMessage: vi.fn<AttachManagedOutgoingMediaToMessageMock>(() => true),
    removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
    settleCorrelatedSubagentDelivery: vi.fn(async () => {}),
    loadPendingSessionDelivery: vi.fn(),
    drainPendingSessionDelivery: vi.fn<DrainPendingSessionDeliveryMock>(),
    recoverPendingSessionDeliveries: vi.fn<RecoverPendingSessionDeliveriesMock>(),
    resolveAgentConfig: vi.fn(() => undefined),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-test-workspace"),
    resolveDefaultAgentId: vi.fn(() => "main"),
    recordInboundSessionAndDispatchReply: vi.fn(
      async (_params: RecordInboundSessionAndDispatchReplyParams) => {},
    ),
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.unmock("./server-restart-sentinel.js");
vi.resetModules();

vi.mock(
  "../agents/subagents/completion/subagent-completion-delivery.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../agents/subagents/completion/subagent-completion-delivery.js")
    >()),
    settleCorrelatedSubagentDelivery: mocks.settleCorrelatedSubagentDelivery,
  }),
);

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveAgentConfig: mocks.resolveAgentConfig,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveSessionAgentId: mocks.resolveSessionAgentId,
  };
});

vi.mock("../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart-sentinel.js")>()),
  finalizeUpdateRestartSentinelRunningVersion: mocks.finalizeUpdateRestartSentinelRunningVersion,
  readRestartSentinel: mocks.readRestartSentinel,
  clearRestartSentinelIfRevision: mocks.clearRestartSentinelIfRevision,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/session-delivery-queue-storage.js")>();
  mocks.enqueueSessionDelivery.mockImplementation(actual.enqueueSessionDelivery);
  mocks.deferSessionDelivery.mockImplementation(async (id, delayMs, stateDir) => {
    if (await actual.loadPendingSessionDelivery(id, stateDir)) {
      await actual.deferSessionDelivery(id, delayMs, stateDir);
    }
  });
  mocks.failSessionDelivery.mockImplementation(async (id, error, stateDir, options) => {
    if (await actual.loadPendingSessionDelivery(id, stateDir)) {
      await actual.failSessionDelivery(id, error, stateDir, options);
    }
  });
  mocks.mergeSessionDeliveryPreparedMediaBlocks.mockImplementation(
    async (id, mediaUrl, blocks, stateDir) => {
      if (await actual.loadPendingSessionDelivery(id, stateDir)) {
        return await actual.mergeSessionDeliveryPreparedMediaBlocks(id, mediaUrl, blocks, stateDir);
      }
      return blocks;
    },
  );
  mocks.loadPendingSessionDelivery.mockImplementation(actual.loadPendingSessionDelivery);
  return {
    ...actual,
    advanceSessionDeliveryAgentRun: mocks.advanceSessionDeliveryAgentRun,
    deferSessionDelivery: mocks.deferSessionDelivery,
    failSessionDelivery: mocks.failSessionDelivery,
    mergeSessionDeliveryPreparedMediaBlocks: mocks.mergeSessionDeliveryPreparedMediaBlocks,
    enqueueSessionDelivery: mocks.enqueueSessionDelivery,
    loadPendingSessionDelivery: mocks.loadPendingSessionDelivery,
    markSessionDeliveryAttemptStarted: mocks.markSessionDeliveryAttemptStarted,
    markSessionDeliverySettlement: mocks.markSessionDeliverySettlement,
  };
});

vi.mock("../infra/session-delivery-queue-recovery.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infra/session-delivery-queue-recovery.js")>();
  mocks.drainPendingSessionDelivery.mockImplementation(actual.drainPendingSessionDelivery);
  mocks.recoverPendingSessionDeliveries.mockImplementation(actual.recoverPendingSessionDeliveries);
  return {
    ...actual,
    drainPendingSessionDelivery: mocks.drainPendingSessionDelivery,
    recoverPendingSessionDeliveries: mocks.recoverPendingSessionDeliveries,
  };
});

vi.mock("../tasks/cron-run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: mocks.removeCronRunContinuationSessionIfIdle,
}));

vi.mock("../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

vi.mock("./managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-image-attachments.js")>()),
  createManagedOutgoingMediaBlocks: mocks.createManagedOutgoingMediaBlocks,
  attachManagedOutgoingMediaToMessage: mocks.attachManagedOutgoingMediaToMessage,
}));

vi.mock("../config/sessions/main-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/main-session.js")>()),
  resolveSystemMainSessionTarget: mocks.resolveSystemMainSessionTarget,
}));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));

vi.mock("../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfoFast: mocks.parseSessionThreadInfo,
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../utils/delivery-context.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/delivery-context.shared.js")>()),
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
}));

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: mocks.getChannelPlugin,
    normalizeChannelId: mocks.normalizeChannelId.mockImplementation(
      (channel?: string | null) =>
        actual.normalizeChannelId(channel) ??
        (typeof channel === "string" && channel.trim().length > 0
          ? channel.trim().toLowerCase()
          : null),
    ),
  };
});

vi.mock("../channels/turn/lifecycle.js", () => ({
  dispatchAssembledChannelTurn: async (params: {
    delivery: {
      preparePayload?: (payload: { text?: string; replyToId?: string | null }) => {
        text?: string;
        replyToId?: string | null;
      };
      deliver: (payload: { text?: string; replyToId?: string | null }) => Promise<void>;
      onError?: (err: unknown, info: { kind: string }) => void;
    };
  }) => {
    await mocks.recordInboundSessionAndDispatchReply({
      ...params,
      deliver: async (payload: { text?: string; replyToId?: string | null }) =>
        params.delivery.deliver(params.delivery.preparePayload?.(payload) ?? payload),
      onDispatchError: (err: unknown, info: { kind: string }) =>
        params.delivery.onError?.(err, info),
    } as unknown as RecordInboundSessionAndDispatchReplyParams);
    return {
      dispatched: true,
      dispatchResult: { observedReplyDelivery: true },
    };
  },
}));

vi.mock("./server-recovery-runtime-context.js", async () => ({
  ...(await vi.importActual<typeof import("./server-recovery-runtime-context.js")>(
    "./server-recovery-runtime-context.js",
  )),
  dispatchGatewayLifecycleMethod: mocks.dispatchGatewayMethodInProcess,
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue-storage.js", () => ({
  ackDelivery: mocks.ackDelivery,
  failDelivery: mocks.failDelivery,
  failDeliveryAfterPlatformSend: mocks.failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend: mocks.failDeliveryBeforePlatformSend,
  failPendingDelivery: mocks.failPendingDelivery,
  findDeliveryIntentOwner: mocks.findDeliveryIntentOwner,
  loadPendingDelivery: async () =>
    mocks.takeInitialOutboundDelivery() ?? (await mocks.loadPendingDelivery()),
  reserveDeliveryAttempt: mocks.reserveDeliveryAttempt,
}));
vi.mock("../infra/outbound/delivery-queue-recovery.js", () => ({
  drainPendingDeliveriesCore: mocks.drainPendingDeliveries,
  withActiveDeliveryClaim: mocks.withActiveDeliveryClaim,
}));

vi.mock("../infra/outbound/delivery-queue-preparation.js", () => ({
  withStableDeliveryPreparation: mocks.withStableDeliveryPreparation,
}));

vi.mock("../infra/outbound/deliver-prepare.js", () => ({
  prepareOutboundPayloadBatch: vi.fn(async (params: { payloads: unknown[] }) => ({
    schemaVersion: 1,
    sourcePayloadCount: params.payloads.length,
    channelNormalized: true,
    entries: params.payloads.map((payload, sourceIndex) => ({
      sourceIndex,
      status: "accepted",
      payload,
      replyHookChanged: false,
      messageHookChanged: false,
      preparedMediaCount: 0,
    })),
  })),
}));

vi.mock("../infra/outbound/deliver-queue-admission.js", () => ({
  stageAndEnqueueOutboundDelivery: vi.fn(
    async (
      params: { deliveryIntentId?: string; payloads: unknown[] },
      preparedBatch: Record<string, unknown>,
    ) => {
      const queued = await mocks.enqueueDeliveryOnce(params, params.deliveryIntentId ?? "");
      if (queued.created) {
        mocks.setInitialOutboundDelivery({
          ...params,
          id: queued.id,
          enqueuedAt: 1,
          retryCount: 0,
          attemptCount: 0,
          preparedBatch,
        });
      }
      return queued;
    },
  ),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: vi.fn(async (params: Record<string, unknown>) => {
    try {
      const results = await mocks.deliverOutboundPayloads(params);
      return { status: "sent", results };
    } catch (error) {
      return { status: "failed", error };
    }
  }),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
    "../infra/heartbeat-wake.js",
  );
  return {
    ...actual,
    requestHeartbeat: mocks.requestHeartbeat,
  };
});

vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  const logger = {
    debug: mocks.logDebug,
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    isEnabled: vi.fn(() => false),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    ...actual,
    createSubsystemLogger: vi.fn((subsystem: string) =>
      subsystem === "gateway/restart-sentinel" ? logger : actual.createSubsystemLogger(subsystem),
    ),
  };
});

const {
  deliverQueuedSessionDelivery,
  getLatestUpdateRestartSentinel,
  recoverPendingRestartContinuationDeliveries,
  refreshLatestUpdateRestartSentinel,
  scheduleRestartSentinelWake,
  settleQueuedSessionDelivery,
} = await import("./server-restart-sentinel.js");
const { resetGatewayWorkAdmission } = await import("../process/gateway-work-admission.js");

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: { mock: { calls: Array<Array<unknown>> } }, callIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0];
}

function lastMockCallArg(mock: { mock: { calls: Array<Array<unknown>> } }): unknown {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("Expected last mock call");
  }
  return call[0];
}

function expectMockCallFields(
  mock: { mock: { calls: Array<Array<unknown>> } },
  expected: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}

function expectNthSystemEventFields(callIndex: number, expected: Record<string, unknown>): void {
  const call = mocks.enqueueSystemEvent.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected enqueueSystemEvent call at index ${callIndex}`);
  }
  expectRecordFields(call[1], expected);
}

function expectContinuationDispatchFields(
  expected: Record<string, unknown>,
  expectedCtx?: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  const params = expectMockCallFields(
    mocks.recordInboundSessionAndDispatchReply,
    expected,
    callIndex,
  );
  if (expectedCtx) {
    expectRecordFields(params.ctxPayload, expectedCtx);
  }
  return params;
}

type GeneratedMediaDeliveryEntry = Extract<
  Parameters<typeof deliverQueuedSessionDelivery>[0]["entry"],
  { kind: "agentTurn" }
>;

function deliverGeneratedMedia(
  overrides: Partial<GeneratedMediaDeliveryEntry> &
    Pick<GeneratedMediaDeliveryEntry, "id" | "messageId">,
  stateDir?: string,
  resolveGatewayContext?: () => undefined,
) {
  return deliverQueuedSessionDelivery({
    deps: {} as never,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(resolveGatewayContext ? { resolveGatewayContext } : {}),
    entry: {
      kind: "agentTurn",
      sessionKey: "agent:main:main",
      message: "generated image ready",
      enqueuedAt: 1,
      retryCount: 0,
      route: { channel: "discord", to: "channel:123", chatType: "channel" },
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "image_generate",
      },
      sourceReplyDeliveryMode: "automatic",
      ...overrides,
    },
  });
}

function mockRestartContinuation(
  continuation: NonNullable<RestartSentinelPayload["continuation"]>,
  threadId?: string,
) {
  mocks.readRestartSentinel.mockResolvedValue({
    payload: {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
      ...(threadId === undefined ? {} : { threadId }),
      ts: 123,
      continuation,
    },
  } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
}

let testState: OpenClawTestState;

describe("scheduleRestartSentinelWake", () => {
  afterEach(async () => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    await testState.cleanup();
  });

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "gateway-restart-sentinel",
      layout: "state-only",
    });
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    mocks.setInitialOutboundDelivery(null);
    mocks.dispatchGatewayMethodInProcess.mockReset();
    mocks.dispatchGatewayMethodInProcess.mockResolvedValue({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });
    mocks.readRestartSentinel.mockReset();
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 123,
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      },
    });
    mocks.parseSessionThreadInfo.mockReset();
    mocks.parseSessionThreadInfo.mockReturnValue({ baseSessionKey: null, threadId: undefined });
    mocks.loadSessionEntry.mockReset();
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      agentId: "main",
      entry: { sessionId: sessionKey, updatedAt: 0 },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
    }));
    mocks.deliveryContextFromSession.mockReset();
    mocks.deliveryContextFromSession.mockReturnValue(undefined);
    mocks.getChannelPlugin.mockReset();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.normalizeChannelId.mockClear();
    mocks.resolveOutboundTarget.mockReset();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "+15550002" });
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]);
    mocks.enqueueDeliveryOnce.mockReset();
    mocks.enqueueDeliveryOnce.mockImplementation(async (_payload, id) => ({ id, created: true }));
    mocks.findDeliveryIntentOwner.mockReset();
    mocks.findDeliveryIntentOwner.mockReturnValue(null);
    mocks.withStableDeliveryPreparation.mockReset();
    mocks.withStableDeliveryPreparation.mockImplementation(
      async (params: {
        id: string;
        run: (owner: {
          current: () => Record<string, unknown>;
          beforeFirstModifier: () => void;
          markPrepared: () => void;
          markPublished: () => void;
        }) => Promise<unknown>;
      }) => ({
        status: "claimed",
        value: await params.run({
          current: () => ({ id: params.id }),
          beforeFirstModifier: () => {},
          markPrepared: () => {},
          markPublished: () => {},
        }),
      }),
    );
    mocks.ackDelivery.mockClear();
    mocks.failDelivery.mockClear();
    mocks.failDeliveryAfterPlatformSend.mockClear();
    mocks.failDeliveryBeforePlatformSend.mockClear();
    mocks.failPendingDelivery.mockClear();
    mocks.loadPendingDelivery.mockReset();
    mocks.loadPendingDelivery.mockResolvedValue(null);
    mocks.drainPendingDeliveries.mockClear();
    mocks.reserveDeliveryAttempt.mockClear();
    mocks.withActiveDeliveryClaim.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestHeartbeat.mockClear();
    mocks.enqueueSessionDelivery.mockClear();
    mocks.advanceSessionDeliveryAgentRun.mockClear();
    mocks.deferSessionDelivery.mockClear();
    mocks.failSessionDelivery.mockClear();
    mocks.mergeSessionDeliveryPreparedMediaBlocks.mockClear();
    mocks.markSessionDeliveryAttemptStarted.mockClear();
    mocks.markSessionDeliverySettlement.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockReset();
    mocks.createManagedOutgoingMediaBlocks.mockReset();
    mocks.attachManagedOutgoingMediaToMessage.mockReset();
    mocks.removeCronRunContinuationSessionIfIdle.mockClear();
    mocks.settleCorrelatedSubagentDelivery.mockClear();
    mocks.loadPendingSessionDelivery.mockClear();
    mocks.drainPendingSessionDelivery.mockClear();
    mocks.recoverPendingSessionDeliveries.mockClear();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockResolvedValue(null);
    mocks.clearRestartSentinelIfRevision.mockReset();
    mocks.clearRestartSentinelIfRevision.mockResolvedValue(true);
    mocks.formatRestartSentinelMessage.mockClear();
    mocks.summarizeRestartSentinel.mockClear();
    mocks.resolveSystemMainSessionTarget.mockReset();
    mocks.resolveSystemMainSessionTarget.mockReturnValue({
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
    mocks.recordInboundSessionAndDispatchReply.mockReset();
    mocks.recordInboundSessionAndDispatchReply.mockResolvedValue(undefined);
    mocks.logInfo.mockClear();
    mocks.logWarn.mockClear();
    mocks.logError.mockClear();
  });

  it.each(["recovered", "moved-to-failed"] as const)(
    "uses one producer settlement callback for startup session recovery (%s)",
    async (outcome) => {
      await recoverPendingRestartContinuationDeliveries({ deps: {} as never });

      const recovery = mocks.recoverPendingSessionDeliveries.mock.calls[0]?.[0];
      expect(recovery?.onSettled).toBe(settleQueuedSessionDelivery);
      const entry = {
        id: "correlated-completion-1",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "retained completion",
        messageId: "completion-1",
        enqueuedAt: 1,
        retryCount: 0,
      } as const;
      await recovery?.onSettled?.(entry, outcome);

      expect(mocks.settleCorrelatedSubagentDelivery).toHaveBeenCalledWith(entry, outcome);
      expect(mocks.removeCronRunContinuationSessionIfIdle).toHaveBeenCalledWith(
        entry.sessionKey,
        entry.id,
      );
      expect(mocks.settleCorrelatedSubagentDelivery.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.removeCronRunContinuationSessionIfIdle.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );

  it("uses the same producer settlement callback for targeted recovery", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    const targeted = mocks.drainPendingSessionDelivery.mock.calls[0]?.[0];
    expect(targeted?.onSettled).toBe(settleQueuedSessionDelivery);
    expect(targeted).toMatchObject({ bypassBackoff: true, id: expect.any(String) });
    expect(targeted).not.toHaveProperty("drainKey");
  });

  it("enqueues the sentinel note and wakes the session even when outbound delivery succeeds", async () => {
    const deps = {} as never;

    await scheduleRestartSentinelWake({ deps });

    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "whatsapp",
      to: "+15550002",
      session: { key: "agent:main:main", agentId: "agent-from-key" },
      deps,
      bestEffort: false,
      skipQueue: true,
      deliveryQueueId: "restart-sentinel-notice:agent:main:main:123",
    });
    expectMockCallFields(mocks.enqueueDeliveryOnce, {
      channel: "whatsapp",
      to: "+15550002",
      payloads: [{ text: "restart message" }],
      bestEffort: false,
      completionRetention: "permanent",
      maxRetries: 45,
    });
    expect(mocks.ackDelivery).toHaveBeenCalledWith("restart-sentinel-notice:agent:main:main:123");
    expect(mocks.reserveDeliveryAttempt).toHaveBeenCalledWith(
      "restart-sentinel-notice:agent:main:main:123",
      45,
    );
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.formatRestartSentinelMessage).toHaveBeenCalledWith(expect.anything());
    expect(mocks.summarizeRestartSentinel).toHaveBeenCalledWith(expect.anything());
    expect(mockCallArg(mocks.enqueueSystemEvent)).toBe("restart message");
    expectNthSystemEventFields(0, {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "appends and broadcasts an internal update outcome once (continuation: %s)",
    async (withContinuation) => {
      const sessionKey = "agent:main:main";
      const sessionId = "internal-update-session";
      const storePath = testState.statePath("agents", "main", "sessions", "sessions.json");
      const entry = { sessionId, updatedAt: 1, lifecycleRevision: "update-lifecycle" };
      await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, entry);
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        agentId: "main",
        entry,
        store: {},
        storePath,
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
        legacyKey: undefined,
      });
      mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat" });
      mocks.readRestartSentinel.mockResolvedValue({
        version: 1,
        revision: 123,
        payload: {
          kind: "update",
          status: "ok",
          ts: 123,
          sessionKey,
          ...(withContinuation
            ? { continuation: { kind: "systemEvent" as const, text: "continue" } }
            : {}),
        },
      });
      const transcript = await vi.importActual<typeof import("../config/sessions/transcript.js")>(
        "../config/sessions/transcript.js",
      );
      mocks.appendAssistantMessageToSessionTranscript.mockImplementation(
        transcript.appendAssistantMessageToSessionTranscript,
      );
      const broadcastToConnIds = vi.fn();
      const subscribers = new Set(["control-ui-connection"]);
      const publish = createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers: { getAll: () => subscribers },
        sessionMessageSubscribers: { get: () => subscribers },
        chatAbortControllers: new Map(),
      });
      const publications: Promise<void>[] = [];
      const publicationErrors: unknown[] = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (update.target?.sessionId === sessionId) {
          publications.push(
            publish(update).catch((error: unknown) => {
              publicationErrors.push(error);
            }),
          );
        }
      });
      try {
        await scheduleRestartSentinelWake({ deps: {} as never });
        await scheduleRestartSentinelWake({ deps: {} as never });
        await Promise.all(publications);
        expect(publicationErrors).toEqual([]);
        expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            sessionKey,
            expectedSessionId: sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
            storePath,
            text: "✅ OpenClaw updated and restarted.",
            idempotencyKey: `restart-sentinel-notice:${sessionKey}:123`,
          }),
        );
        const events = await loadTranscriptEvents({
          agentId: "main",
          sessionId,
          sessionKey,
          storePath,
        });
        expect(events.filter((event) => asOptionalRecord(event)?.type === "message")).toHaveLength(
          1,
        );
        expect(broadcastToConnIds).toHaveBeenCalledOnce();
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "session.message",
          expect.objectContaining({
            sessionKey,
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "✅ OpenClaw updated and restarted." }],
            }),
          }),
          subscribers,
        );
        expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
        if (withContinuation) {
          expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(2);
          expect(mocks.enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual([
            "restart message",
            "continue",
          ]);
        } else {
          expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
          expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
        }
        expect(mocks.logWarn).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        await Promise.allSettled(publications);
      }
    },
  );

  it.each(["failed", "stale", "thrown"])(
    "warns and wakes the internal session when the update notice append is %s",
    async (failure) => {
      mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat" });
      mocks.readRestartSentinel.mockResolvedValue({
        version: 1,
        revision: 123,
        payload: { kind: "update", status: "error", ts: 123, sessionKey: "agent:main:main" },
      });
      if (failure === "thrown") {
        mocks.appendAssistantMessageToSessionTranscript.mockRejectedValue(
          new Error("append failed"),
        );
      } else {
        mocks.appendAssistantMessageToSessionTranscript.mockResolvedValue({
          ok: false,
          reason: "append failed",
          ...(failure === "stale" ? { code: "session-rebound" as const } : {}),
        });
      }

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(mocks.logWarn).toHaveBeenCalledWith(
        "restart summary: internal restart notice append failed; falling back to wake: append failed",
        { sessionKey: "agent:main:main" },
      );
      expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
        "restart message",
        expect.objectContaining({ sessionKey: "agent:main:main" }),
      );
      expect(mocks.requestHeartbeat).toHaveBeenCalledOnce();
      expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "update", status: "ok", notice: "✅ OpenClaw updated and restarted." },
    {
      kind: "update",
      status: "skipped",
      notice: "ℹ️ OpenClaw update skipped: already-current.",
    },
    {
      kind: "update",
      status: "error",
      notice:
        "⚠️ OpenClaw update failed: verification failed. The gateway is running the previous version.",
    },
    {
      kind: "restart",
      status: "ok",
      notice: "Gateway restart ok (npm)\n/restart\nReason: verification failed",
    },
  ] as const)(
    "keeps durable $kind/$status notice delivery separate from the wake",
    async ({ kind, status, notice }) => {
      const payload: RestartSentinelPayload = {
        kind,
        status,
        ts: 123,
        sessionKey: "agent:main:main",
        message: kind === "restart" ? "/restart" : "/update",
        stats: {
          mode: "npm",
          reason: status === "skipped" ? "already-current" : "verification failed",
        },
      };
      const { formatRestartSentinelMessage } = await vi.importActual<
        typeof import("../infra/restart-sentinel.js")
      >("../infra/restart-sentinel.js");
      const wake = formatRestartSentinelMessage(payload);
      mocks.formatRestartSentinelMessage.mockReturnValueOnce(wake);
      mocks.deliveryContextFromSession.mockReturnValue({ channel: "telegram", to: "chat-123" });
      mocks.readRestartSentinel.mockResolvedValue({ version: 1, revision: 123, payload });
      mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "chat-123" });

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
      expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "telegram",
          to: "chat-123",
          payloads: [{ text: notice }],
        }),
        "restart-sentinel-notice:agent:main:main:123",
      );
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ payloads: [{ text: notice }] }),
      );
      expect(mocks.formatRestartSentinelMessage).toHaveBeenCalledWith(payload);
      expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
        wake,
        expect.objectContaining({ sessionKey: "agent:main:main" }),
      );
      expect(mocks.requestHeartbeat).toHaveBeenCalledOnce();
    },
  );

  it("persists every downstream intent before consuming the loaded revision", async () => {
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledWith(123);
    const clearOrder = mocks.clearRestartSentinelIfRevision.mock.invocationCallOrder[0] ?? 0;
    expect(mocks.enqueueSessionDelivery.mock.invocationCallOrder[0]).toBeLessThan(clearOrder);
    expect(mocks.enqueueDeliveryOnce.mock.invocationCallOrder[0]).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(mocks.enqueueSystemEvent.mock.invocationCallOrder[0] ?? 0);
    expect(clearOrder).toBeLessThan(mocks.deliverOutboundPayloads.mock.invocationCallOrder[0] ?? 0);
  });

  it("stops delivery when guarded sentinel consumption fails", async () => {
    mocks.clearRestartSentinelIfRevision.mockRejectedValueOnce(new Error("database locked"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledOnce();
    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledOnce();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "database locked",
    });
  });

  it("preserves a newer sentinel while draining durable work from the loaded revision", async () => {
    mocks.clearRestartSentinelIfRevision.mockResolvedValueOnce(false);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledWith(123);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "restart summary: newer restart sentinel preserved while draining durable work",
      { sessionKey: "agent:main:main" },
    );
  });

  it("does not resend a restart notice whose stable queue id is already owned", async () => {
    mocks.withStableDeliveryPreparation.mockResolvedValueOnce({ status: "existing" });
    mocks.findDeliveryIntentOwner.mockReturnValueOnce({
      namespace: "prepared",
      status: "pending",
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledWith(123);
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "restart summary: durable restart notice already owned",
      { sessionKey: "agent:main:main" },
    );
  });

  it("queues the restart wake before a system-event continuation", async () => {
    mocks.readRestartSentinel.mockResolvedValueOnce({
      version: 1,
      revision: 123,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 99,
        sessionKey: "agent:main:main",
        continuation: { kind: "systemEvent", text: "continue" },
      },
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueSessionDelivery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: "restart message",
        idempotencyKey: "restart-sentinel-wake:agent:main:main:123",
        completionRetention: "permanent",
      }),
    );
    expect(mocks.enqueueSessionDelivery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "continue",
        idempotencyKey: "restart-sentinel:agent:main:main:systemEvent:123",
        completionRetention: "permanent",
      }),
    );
    expect(mocks.enqueueSystemEvent.mock.calls.map((call) => call[0])).toEqual([
      "restart message",
      "continue",
    ]);
  });

  it("queues a failed outbound notice for durable recovery without dropping the agent wake", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("platform outcome unknown"));
    mocks.loadPendingDelivery
      .mockResolvedValueOnce({
        id: "restart-sentinel-notice:agent:main:main:123",
        retryCount: 1,
        lastError: "platform outcome unknown",
      } as never)
      .mockResolvedValue(null);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      skipQueue: true,
      deliveryQueueId: "restart-sentinel-notice:agent:main:main:123",
    });
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).toHaveBeenCalledWith(
      "restart-sentinel-notice:agent:main:main:123",
      "platform outcome unknown",
    );
    expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    expectRecordFields(mockCallArg(mocks.drainPendingDeliveries), {
      drainKey: "restart-recovery:restart-sentinel-notice:agent:main:main:123",
      deliver: expect.any(Function),
    });
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: outbound delivery failed; queued for recovery: Error: platform outcome unknown",
      {
        channel: "whatsapp",
        to: "+15550002",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("schedules safe recovery when the delivered notice cannot be acknowledged", async () => {
    mocks.ackDelivery.mockRejectedValueOnce(new Error("ack unavailable"));
    mocks.loadPendingDelivery
      .mockResolvedValueOnce({
        id: "restart-sentinel-notice:agent:main:main:123",
        retryCount: 1,
        recoveryState: "unknown_after_send",
      } as never)
      .mockResolvedValue(null);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.failDeliveryAfterPlatformSend).toHaveBeenCalledWith(
      "restart-sentinel-notice:agent:main:main:123",
      "ack unavailable",
    );
    expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: outbound delivery ack failed; queued for recovery: ack unavailable",
      {
        channel: "whatsapp",
        to: "+15550002",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("still dispatches continuation after a restart notice is queued for recovery", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("transport still not ready"));
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue",
        },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.failDelivery).toHaveBeenCalledWith(
      "restart-sentinel-notice:agent:main:main:123",
      "transport still not ready",
    );
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expectContinuationDispatchFields({ routeSessionKey: "agent:main:main" }, { Body: "continue" });
  });

  it("prefers top-level sentinel threadId for wake routing context", async () => {
    // Legacy or malformed sentinel JSON can still carry a nested threadId.
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "stale-thread",
        } as never,
        threadId: "fresh-thread",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
        threadId: "fresh-thread",
      },
    });
  });

  it("runs agentTurn continuation internally after the restart notice without routed final delivery", async () => {
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "Reply with exactly: Yay! I did it!",
      },
      "thread-42",
    );
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.turnAdoptionLifecycle?.onAdopted();
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectMockCallFields(mocks.enqueueDeliveryOnce, {
      payloads: [{ text: "restart message" }],
      threadId: "thread-42",
    });
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), kind: "agentTurn" }),
    );
    expectContinuationDispatchFields(
      {
        channel: "whatsapp",
        accountId: "acct-2",
        routeSessionKey: "agent:main:main",
        replyOptions: expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
      },
      {
        Body: "Reply with exactly: Yay! I did it!",
        BodyForAgent: "Reply with exactly: Yay! I did it!",
        BodyForCommands: "",
        CommandBody: "",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.admin"],
        GatewayClientCaps: [],
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "whatsapp",
          sourceTool: "restart-sentinel",
        },
        SessionKey: "agent:main:main",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "+15550002",
        ExplicitDeliverRoute: false,
        MessageThreadId: "thread-42",
      },
    );
    const deliveredContinuationReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredContinuationReply).toBe(false);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("replays generated-media provenance through the owning session agent", async () => {
    const resolveGatewayContext = () => undefined;
    await deliverGeneratedMedia(
      {
        id: "session-delivery-media",
        messageId: "image:task-1:agent-loop",
        route: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          chatType: "channel",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "image_generate:task-1",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
        idempotencyKey: "image:task-1:agent-loop",
      },
      "/tmp/custom-session-delivery-state",
      resolveGatewayContext,
    );

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      {
        sessionKey: "agent:main:main",
        message: "generated image ready",
        deliver: true,
        bestEffortDeliver: false,
        channel: "discord",
        accountId: "default",
        to: "channel:123",
        threadId: undefined,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "image_generate:task-1",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        disableMessageTool: true,
        forceRestartSafeTools: true,
        idempotencyKey: "image:task-1:agent-loop",
      },
      {
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        resolveGatewayContext,
        onAccepted: expect.any(Function),
      },
    );
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media", kind: "agentTurn" }),
      "/tmp/custom-session-delivery-state",
    );
  });

  it("fences an adopted generic turn in its explicit queue state directory", async () => {
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.turnAdoptionLifecycle?.onAdopted();
    });

    await deliverQueuedSessionDelivery({
      deps: {} as never,
      stateDir: "/tmp/custom-generic-session-delivery-state",
      entry: {
        id: "session-delivery-generic-state-dir",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "continue",
        messageId: "restart-sentinel:generic-state-dir",
        enqueuedAt: 1,
        retryCount: 0,
        route: { channel: "discord", to: "channel:123", chatType: "channel" },
      },
    });

    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-generic-state-dir" }),
      "/tmp/custom-generic-session-delivery-state",
    );
  });

  it("keeps a generated-media gateway rejection before acceptance retryable", async () => {
    mocks.dispatchGatewayMethodInProcess.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-pre-accept",
        messageId: "image:task-pre-accept:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("failed before gateway acceptance");

    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media-pre-accept" }),
    );
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
  });

  it("authorizes queued media replay for an active cron continuation", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "cron-run-session",
        cronRunContinuation: {
          lifecycleRevision: "revision-1",
          phase: "ready",
          basePersisted: true,
        },
        updatedAt: 1,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:cron:daily-media:run:run-123",
      storeKeys: ["agent:main:cron:daily-media:run:run-123"],
      legacyKey: undefined,
    });

    await deliverGeneratedMedia({
      id: "session-delivery-cron-media",
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      messageId: "image:cron-task:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
      suppressTextDelivery: true,
    });

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        sessionKey: "agent:main:cron:daily-media:run:run-123",
        sessionId: "cron-run-session",
      }),
      {
        allowSyntheticCronRunContinuation: true,
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        internalDeliverySuppressText: true,
        onAccepted: expect.any(Function),
      },
    );
  });

  it("defers a generated-media turn still owned by agent recovery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "in_flight" });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "image:task-owned:agent-loop",
        updatedAt: 1,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-owned",
        messageId: "image:task-owned:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("still owned by agent recovery");

    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith("session-delivery-media-owned", 1_000);
  });

  it("retains the local fence when gateway dedupe reports another in-flight owner", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "in_flight" });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-in-flight",
        messageId: "image:task-in-flight:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("still owned by agent recovery");

    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-delivery-media-in-flight" }),
    );
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-in-flight",
      1_000,
    );
  });

  it("fails closed when a terminal agent turn has no replayable result", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal:agent-loop"],
        updatedAt: 1,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal",
        messageId: "image:task-terminal:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered without durable terminal evidence");
  });

  it("retries a captured empty terminal result instead of dead-lettering it", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal-empty:agent-loop"],
        restartRecoveryTerminalDeliveryEvidence: [
          { runId: "image:task-terminal-empty:agent-loop", captured: true },
        ],
        updatedAt: 1,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal-empty",
        message: "generation completed",
        messageId: "image:task-terminal-empty:agent-loop",
        retryCount: 1,
        lastChargedAgentRunAttempt: 0,
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: [],
      }),
    ).rejects.toThrow("completed without a visible reply");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-terminal-empty",
    );
    expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-empty",
      1_000,
    );
  });

  it("uses durable terminal evidence to retry media omitted before queue acknowledgement", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal-missing:agent-loop"],
        restartRecoveryTerminalDeliveryEvidence: [
          {
            runId: "image:task-terminal-missing:agent-loop",
            payloads: [{ visible: true }],
            deliveryStatus: { status: "sent" },
          },
        ],
        updatedAt: 1,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal-missing",
        messageId: "image:task-terminal-missing:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-terminal-missing",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
    );
    expect(mocks.failSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-missing",
      expect.stringContaining("missed expected media"),
    );
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-missing",
      1_000,
    );
    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("dead-letters an interrupted attempt without durable agent evidence", async () => {
    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-interrupted-unproven",
        messageId: "image:task-interrupted-unproven:agent-loop",
        deliveryStartedAt: 2,
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("interrupted unproven attempt");

    expect(mocks.dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });

  it("does not replay private terminal media as an owning-transcript delivery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "ok" });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        restartRecoveryTerminalRunIds: ["image:task-terminal-private:agent-loop"],
        restartRecoveryTerminalDeliveryEvidence: [
          {
            runId: "image:task-terminal-private:agent-loop",
            payloads: [{ visible: false, mediaUrls: ["/tmp/proof.png"] }],
          },
        ],
        updatedAt: 1,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-terminal-private",
        messageId: "image:task-terminal-private:agent-loop",
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-terminal-private",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
    );
    expect(mocks.failSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-private",
      expect.stringContaining("missed expected media"),
    );
    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith(
      "session-delivery-media-terminal-private",
      1_000,
    );
  });

  it("asks the normal agent loop to deliver automatic generated-media replies", async () => {
    await deliverGeneratedMedia({
      id: "session-delivery-media-automatic",
      messageId: "image:task-automatic:agent-loop",
      route: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
        chatType: "channel",
      },
      expectedMediaUrls: ["/tmp/proof.png"],
      suppressTextDelivery: true,
    });

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        deliver: true,
        sourceReplyDeliveryMode: "automatic",
        disableMessageTool: true,
        forceRestartSafeTools: true,
        idempotencyKey: "image:task-automatic:agent-loop",
      }),
      {
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        internalDeliverySuppressText: true,
        onAccepted: expect.any(Function),
      },
    );
  });

  it("accepts normalized generated-media evidence without a bare retry", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/generated image.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });

    await deliverGeneratedMedia({
      id: "session-delivery-media-normalized",
      messageId: "image:task-normalized:agent-loop",
      idempotencyKey: "image:task-normalized:agent-loop",
      expectedMediaUrls: ["file:///tmp/generated%20image.png"],
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deferSessionDelivery).not.toHaveBeenCalled();
  });

  it("persists internal generated audio as managed transcript content", async () => {
    const attachment = {
      type: "audio" as const,
      mediaUrl: "/tmp/proof.mp3",
      mimeType: "audio/mpeg",
    };
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: { payloads: [{ text: "ready", mediaUrls: [attachment.mediaUrl] }] },
    });

    await deliverGeneratedMedia({
      id: `session-delivery-media-internal-${attachment.type}`,
      messageId: `${attachment.type}:task-internal:agent-loop`,
      route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
      expectedMediaUrls: [attachment.mediaUrl],
      expectedMediaAttachments: {
        [attachment.mediaUrl]: {
          type: attachment.type,
          path: attachment.mediaUrl,
          mimeType: attachment.mimeType,
        },
      },
    });

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ deliver: false, sourceReplyDeliveryMode: "automatic" }),
      expect.objectContaining({ internalDeliveryMediaUrls: [attachment.mediaUrl] }),
    );
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      items: [
        {
          url: attachment.mediaUrl,
          mimeType: attachment.mimeType,
          trustedLocal: true,
        },
      ],
      stateDir: testState.stateDir,
      localRoots: [testState.statePath("media")],
    });
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [],
        displayContent: [expect.objectContaining({ type: attachment.type })],
        idempotencyKey: `${attachment.type}:task-internal:agent-loop:generated-media-transcript`,
      }),
    );
    expect(mocks.attachManagedOutgoingMediaToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "generated-media-transcript" }),
    );
    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("persists targetless global generated media in its resolved owner transcript", async () => {
    const sessionId = "ops-global-session";
    const mediaPath = testState.statePath("media", "tool-image-generation", "proof.png");
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
    const opsStorePath = testState.statePath("agents", "ops", "sessions", "sessions.json");
    const researchStorePath = testState.statePath(
      "agents",
      "research",
      "sessions",
      "sessions.json",
    );
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "global", storePath: opsStorePath },
      { sessionId, updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { agentId: "research", sessionKey: "global", storePath: researchStorePath },
      { sessionId: "research-global-session", updatedAt: 1 },
    );
    const transcriptActual = await vi.importActual<
      typeof import("../config/sessions/transcript.js")
    >("../config/sessions/transcript.js");
    const managedMediaActual = await vi.importActual<
      typeof import("./managed-image-attachments.js")
    >("./managed-image-attachments.js");
    const queueStorageActual = await vi.importActual<
      typeof import("../infra/session-delivery-queue-storage.js")
    >("../infra/session-delivery-queue-storage.js");
    const { readManagedImageRecord } = await import("./managed-image-record-store.js");
    mocks.appendAssistantMessageToSessionTranscript
      .mockImplementationOnce(transcriptActual.appendAssistantMessageToSessionTranscript)
      .mockImplementationOnce(transcriptActual.appendAssistantMessageToSessionTranscript);
    mocks.createManagedOutgoingMediaBlocks.mockImplementation(
      managedMediaActual.createManagedOutgoingMediaBlocks,
    );
    mocks.attachManagedOutgoingMediaToMessage
      .mockImplementationOnce(() => {
        throw new Error("synthetic crash after transcript append");
      })
      .mockImplementationOnce(managedMediaActual.attachManagedOutgoingMediaToMessage);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "ops",
      entry: { sessionId, updatedAt: 1 },
      store: {},
      storePath: opsStorePath,
      canonicalKey: "global",
      storeKeys: ["global"],
      legacyKey: undefined,
    });

    const queueId = await queueStorageActual.enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "global",
        message: "generated image ready",
        messageId: "image:task-global:agent-loop",
        route: { channel: "webchat", to: "global", chatType: "direct" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: [mediaPath],
        expectedMediaAttachments: {
          [mediaPath]: {
            type: "image",
            path: mediaPath,
            name: "proof.png",
            mimeType: "image/png",
            sizeBytes: (await fs.stat(mediaPath)).size,
            width: 1,
            height: 1,
          },
        },
        idempotencyKey: "image:task-global:agent-loop",
      },
      testState.stateDir,
    );
    const firstAttempt = await queueStorageActual.loadPendingSessionDelivery(
      queueId,
      testState.stateDir,
    );
    if (!firstAttempt || firstAttempt.kind !== "agentTurn") {
      throw new Error("expected queued generated media attempt");
    }
    mocks.dispatchGatewayMethodInProcess.mockResolvedValue({
      status: "ok",
      result: { payloads: [{ text: "ready", mediaUrls: [mediaPath] }] },
    });

    await expect(deliverGeneratedMedia(firstAttempt, testState.stateDir)).rejects.toThrow(
      "synthetic crash after transcript append",
    );
    const replayAttempt = await queueStorageActual.loadPendingSessionDelivery(
      queueId,
      testState.stateDir,
    );
    if (!replayAttempt || replayAttempt.kind !== "agentTurn") {
      throw new Error("expected prepared generated media replay");
    }
    const firstPreparedBlocks = replayAttempt.preparedMediaBlocks?.[mediaPath];
    expect(firstPreparedBlocks).toEqual([
      expect.objectContaining({ type: "image", artifactId: expect.any(String) }),
    ]);

    await deliverGeneratedMedia(replayAttempt, testState.stateDir);
    const afterReplay = await queueStorageActual.loadPendingSessionDelivery(
      queueId,
      testState.stateDir,
    );
    expect(
      afterReplay?.kind === "agentTurn" ? afterReplay.preparedMediaBlocks?.[mediaPath] : null,
    ).toEqual(firstPreparedBlocks);
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledTimes(1);

    const opsEvents = await loadTranscriptEvents({
      agentId: "ops",
      sessionId,
      sessionKey: "global",
      storePath: opsStorePath,
    });
    expect(opsEvents).toHaveLength(2);
    expect(opsEvents[0]).toMatchObject({ type: "session", id: sessionId });
    const messageEvent = opsEvents[1] as {
      id?: string;
      message?: {
        role?: string;
        content?: Array<Record<string, unknown>>;
        openclawDisplayContent?: Array<Record<string, unknown>>;
      };
    };
    expect(messageEvent.message).toMatchObject({
      role: "assistant",
      content: [],
      openclawDisplayContent: [
        expect.objectContaining({ type: "image", artifactId: expect.any(String) }),
      ],
    });
    expect(messageEvent.message?.openclawDisplayContent).not.toEqual([
      { type: "text", text: path.basename(mediaPath) },
    ]);
    const imageBlock = messageEvent.message?.openclawDisplayContent?.[0];
    const artifactId = imageBlock?.artifactId;
    expect(artifactId).toBeTypeOf("string");
    const parsedArtifact = managedMediaActual.parseManagedOutgoingArtifactId(String(artifactId));
    expect(parsedArtifact).not.toBeNull();
    const record = readManagedImageRecord(parsedArtifact?.attachmentId ?? "", testState.stateDir);
    expect(record).toMatchObject({ messageId: messageEvent.id, sessionKey: "global" });
    await expect(
      managedMediaActual.resolveManagedOutgoingMediaArtifactDownload({
        sessionKey: "global",
        agentId: "ops",
        artifactId: String(artifactId),
        stateDir: testState.stateDir,
      }),
    ).resolves.toMatchObject({ artifactId, type: "image" });
    await expect(
      loadTranscriptEvents({
        agentId: "research",
        sessionId: "research-global-session",
        sessionKey: "global",
        storePath: researchStorePath,
      }),
    ).resolves.toEqual([]);
    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deferSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.markSessionDeliverySettlement).not.toHaveBeenCalled();
  });

  it("persists proven internal media before retrying the missing subset", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: { payloads: [{ text: "first ready", mediaUrls: ["/tmp/one.png"] }] },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-internal-partial",
        message: "generated images ready",
        messageId: "image:task-internal-partial:agent-loop",
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        expectedMediaAttachments: {
          "/tmp/one.png": { type: "image", path: "/tmp/one.png", name: "one.png" },
          "/tmp/two.png": { type: "image", path: "/tmp/two.png", name: "two.png" },
        },
      }),
    ).rejects.toThrow("partially missed expected media: /tmp/two.png");

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        content: [],
        displayContent: [expect.objectContaining({ type: "image" })],
        storePath: "/tmp/sessions.json",
        idempotencyKey: "image:task-internal-partial:agent-loop:generated-media-transcript",
      }),
    );
    expect(mocks.createManagedOutgoingMediaBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          {
            url: "/tmp/one.png",
            filename: "one.png",
            trustedLocal: true,
          },
        ],
      }),
    );
    expect(mocks.mergeSessionDeliveryPreparedMediaBlocks).toHaveBeenCalledWith(
      "session-delivery-media-internal-partial",
      "/tmp/one.png",
      [expect.objectContaining({ type: "image" })],
      testState.stateDir,
    );
    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-internal-partial",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/two.png"] }),
    );
  });

  it("does not count private reasoning media as an owning-transcript reply", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ isReasoning: true, mediaUrls: ["/tmp/proof.png"] }],
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-internal-reasoning",
        messageId: "image:task-internal-reasoning:agent-loop",
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-internal-reasoning",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
    );
  });

  it("retries a completed agent turn that omitted the expected media", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "generation finished" }],
        deliveryStatus: { status: "sent" },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-missing",
        messageId: "image:task-missing:agent-loop",
        idempotencyKey: "image:task-missing:agent-loop",
        retryCount: 2,
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("queued generated-media agent turn missed expected media: /tmp/proof.png");

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ idempotencyKey: "image:task-missing:agent-loop" }),
      expect.any(Object),
    );
    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-missing",
      {
        expectedMediaUrls: ["/tmp/proof.png"],
        message: expect.stringContaining("MEDIA:/tmp/proof.png"),
        suppressTextDelivery: true,
      },
    );
  });

  it("retries when automatic aggregate evidence contains media only in a hidden payload", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [
          { text: "generation finished" },
          { visible: false, mediaUrls: ["/tmp/proof.png"] },
        ],
        deliveryStatus: { status: "sent" },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-hidden-aggregate",
        messageId: "image:task-hidden-aggregate:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-hidden-aggregate",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
    );
  });

  it("accepts suppressed automatic media as a committed durable delivery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "suppressed" },
      },
    });

    await deliverGeneratedMedia({
      id: "session-delivery-media-suppressed",
      messageId: "image:task-suppressed:agent-loop",
      expectedMediaUrls: ["/tmp/proof.png"],
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("accepts a suppressed visible automatic completion notice", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "generation failed" }],
        deliveryStatus: { status: "suppressed" },
      },
    });

    await deliverGeneratedMedia({
      id: "session-delivery-notice-suppressed",
      message: "generation failed",
      messageId: "image:task-notice-suppressed:agent-loop",
      expectedMediaUrls: [],
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("retries only media proven missing from a successful partial delivery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/one.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-partial-safe",
        message: "generated images ready",
        messageId: "image:task-partial-safe:agent-loop",
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      }),
    ).rejects.toThrow("partially missed expected media: /tmp/two.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-partial-safe",
      {
        expectedMediaUrls: ["/tmp/two.png"],
        message: expect.stringContaining("MEDIA:/tmp/two.png"),
        suppressTextDelivery: true,
      },
    );
    const retryMessage = (
      mocks.advanceSessionDeliveryAgentRun.mock.calls[0]?.[1] as { message?: string } | undefined
    )?.message;
    expect(retryMessage).not.toContain("/tmp/one.png");
  });

  it("checks partial automatic evidence only for media still missing", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ mediaUrls: ["/tmp/one.png"] }, { mediaUrls: ["/tmp/two.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "second attachment failed before send",
          payloadOutcomes: [
            { index: 0, status: "sent" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-cross-path-partial",
        message: "generated images ready",
        messageId: "image:task-cross-path-partial:agent-loop",
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/two.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-cross-path-partial",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/two.png"] }),
    );
  });

  it("suppresses ambiguous caption replay while repairing missing media", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready" }, { mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "attachment failed before send",
          payloadOutcomes: [{ index: 1, status: "failed", sentBeforeError: false }],
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-caption-ambiguous",
        messageId: "image:task-caption-ambiguous:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-caption-ambiguous",
      expect.objectContaining({
        expectedMediaUrls: ["/tmp/proof.png"],
        suppressTextDelivery: true,
      }),
    );
  });

  it("does not accept explicitly hidden automatic evidence as a visible notice", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ visible: false, mediaUrls: ["/tmp/private.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-hidden-automatic",
        message: "generated images ready",
        messageId: "image:task-hidden-automatic:agent-loop",
      }),
    ).rejects.toThrow("completed without a visible reply");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-hidden-automatic",
    );
  });

  it("retries missing media after an unrelated text payload was sent", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready" }, { mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "attachment failed",
          payloadOutcomes: [
            { index: 0, status: "sent" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-text-only",
        messageId: "image:task-text-only:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalled();
  });

  it("dead-letters a partial send without exact per-payload evidence", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "transport failed after an unknown side effect",
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-partial-unclassified",
        messageId: "image:task-partial-unclassified:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after ambiguous side effects");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters truncated terminal evidence before retrying missing media", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "earlier payload" }],
        payloadsTruncated: true,
        deliveryStatus: { status: "sent" },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-truncated",
        messageId: "image:task-truncated:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after truncated evidence");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters impossible truncated messaging-tool evidence", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:wrong",
            mediaUrls: ["/tmp/proof.png"],
          },
        ],
        messagingToolSentTargetsTruncated: true,
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-tool-targets-truncated",
        messageId: "image:task-tool-targets-truncated:agent-loop",
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters aggregate-only message-tool evidence before replaying", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["/tmp/proof.png"],
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-tool-aggregate-only",
        messageId: "image:task-tool-aggregate-only:agent-loop",
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters unaccounted aggregate evidence mixed with routed tool sends", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            mediaUrls: ["/tmp/one.png"],
          },
        ],
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-tool-mixed-aggregate",
        message: "generated images ready",
        messageId: "image:task-tool-mixed-aggregate:agent-loop",
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters impossible message-tool delivery to a different destination", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [],
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:wrong",
            mediaUrls: ["/tmp/proof.png"],
          },
        ],
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-wrong-target",
        messageId: "image:task-wrong-target:agent-loop",
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters impossible committed side effects before a fresh attempt", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready" }],
        successfulCronAdds: 1,
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-unsafe-side-effect",
        messageId: "image:task-unsafe-side-effect:agent-loop",
        expectedMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
  });

  it("dead-letters a partial visible send instead of replaying it", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/one.png", "/tmp/two.png"] }],
        deliveryStatus: {
          status: "partial_failed",
          errorMessage: "second attachment failed after first send",
          payloadOutcomes: [{ index: 0, status: "failed", sentBeforeError: true }],
        },
      },
    });

    await expect(
      deliverGeneratedMedia({
        id: "session-delivery-media-partial",
        message: "generated images ready",
        messageId: "image:task-partial:agent-loop",
        expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      }),
    ).rejects.toThrow("dead-lettered after ambiguous side effects");
  });

  it("dispatches agentTurn continuation for a completed run entry", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
        threadId: "thread-42",
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue after restart",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        updatedAt: Date.now(),
        status: "done",
        endedAt: Date.now() - 1_000,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "continue after restart",
        messageId: "restart-sentinel:agent:main:main:agentTurn:123",
        expectedSessionId: "agent:main:main",
        completionRetention: "permanent",
        route: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "thread-42",
          chatType: "direct",
        },
      }),
    );
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expectContinuationDispatchFields(
      { routeSessionKey: "agent:main:main" },
      { Body: "continue after restart" },
    );
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("does not dispatch a queued agentTurn continuation after the session key changes", async () => {
    const activeEntry: LoadedSessionEntry = {
      cfg: {},
      entry: {
        sessionId: "old-session-id",
        updatedAt: Date.now(),
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    };
    const replacementEntry: LoadedSessionEntry = {
      cfg: {},
      entry: {
        sessionId: "new-session-id",
        updatedAt: Date.now(),
        status: "done",
        endedAt: Date.now() - 1_000,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    };
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "continue after restart",
      },
      "thread-42",
    );
    mocks.loadSessionEntry.mockReturnValueOnce(activeEntry).mockReturnValue(replacementEntry);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("continue after restart", {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
        threadId: "thread-42",
      },
    });
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.logWarn).toHaveBeenCalledWith("restart continuation skipped: session changed", {
      sessionKey: "agent:main:main",
      queueId: expect.any(String),
      expectedSessionId: "old-session-id",
      actualSessionId: "new-session-id",
    });
  });

  it("still delivers systemEvent continuations for completed run entries", async () => {
    mockRestartContinuation(
      {
        kind: "systemEvent",
        text: "continue after restart",
      },
      "thread-42",
    );
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        updatedAt: Date.now(),
        status: "done",
        endedAt: Date.now() - 1_000,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(2, "continue after restart", {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
        threadId: "thread-42",
      },
    });
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalledWith(
      "restart continuation skipped: session changed",
      expect.anything(),
    );
  });

  it("preserves the session chat type for agentTurn continuations", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:group",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1001",
          accountId: "default",
        },
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:group",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram" },
          origin: { provider: "telegram", chatType: "group" },
        }),
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:group",
      storeKeys: ["agent:main:group"],
      legacyKey: undefined,
    });
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "telegram:-1001" });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectContinuationDispatchFields(
      {
        channel: "telegram",
        routeSessionKey: "agent:main:group",
      },
      {
        ChatType: "group",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1001",
      },
    );
  });

  it("authorizes routed agentTurn continuations while preserving Telegram topic routing", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:telegram:group:-1003826723328:topic:13757",
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue in topic",
        },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:telegram:group:-1003826723328",
      threadId: "13757",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:telegram:group:-1003826723328:topic:13757",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram" },
          origin: { provider: "telegram", chatType: "group" },
        }),
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:telegram:group:-1003826723328:topic:13757",
      storeKeys: ["agent:main:telegram:group:-1003826723328:topic:13757"],
      legacyKey: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "telegram",
      to: "telegram:-1003826723328:topic:13757",
      accountId: "default",
      threadId: 13757,
    });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "telegram:-1003826723328:topic:13757",
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectContinuationDispatchFields(
      {
        channel: "telegram",
        accountId: "default",
        routeSessionKey: "agent:main:telegram:group:-1003826723328:topic:13757",
        replyOptions: expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
      },
      {
        Body: "continue in topic",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.admin"],
        GatewayClientCaps: [],
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "group",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003826723328:topic:13757",
        ExplicitDeliverRoute: false,
        MessageThreadId: "13757",
      },
    );
  });

  it("preserves derived reply transport ids in internal continuation context", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "WhatsApp",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      threading: {
        resolveReplyTransport: ({ threadId }: { threadId?: string | number | null }) => ({
          replyToId: threadId != null ? `reply:${String(threadId)}` : undefined,
          threadId: null,
        }),
      },
    });
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "continue",
      },
      "thread-42",
    );
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectContinuationDispatchFields(
      {},
      {
        ReplyToId: "reply:thread-42",
        MessageThreadId: undefined,
      },
    );
    const deliveredContinuationReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredContinuationReply).toBe(false);
  });

  it("dispatches agentTurn continuation from session delivery context when sentinel routing is empty", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:main",
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue",
        },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "telegram",
      to: "telegram:200482621",
      accountId: "default",
    });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "telegram:200482621",
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectContinuationDispatchFields(
      {
        channel: "telegram",
        accountId: "default",
      },
      {
        Body: "continue",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:200482621",
      },
    );
  });

  it("requests another wake after enqueueing a systemEvent continuation", async () => {
    mockRestartContinuation(
      {
        kind: "systemEvent",
        text: "continue after restart",
      },
      "thread-42",
    );

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(2, "continue after restart", {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
        threadId: "thread-42",
      },
    });
    expect(mocks.requestHeartbeat).toHaveBeenNthCalledWith(1, {
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeat).toHaveBeenNthCalledWith(2, {
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:main",
    });
  });

  it("enqueues systemEvent continuation without stale partial delivery context", async () => {
    mockRestartContinuation(
      {
        kind: "systemEvent",
        text: "continue after restart",
      },
      "thread-42",
    );
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("missing route"),
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(2, "continue after restart", {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
        threadId: "thread-42",
      },
    });
  });

  it("logs and continues when continuation delivery fails", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.recordInboundSessionAndDispatchReply.mockRejectedValueOnce(new Error("dispatch failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledOnce();
    expect(mocks.logWarn.mock.calls[0]?.[0]).toMatch(
      /^restart continuation: retry failed for entry [0-9a-f]{64}: dispatch failed$/,
    );
  });

  it("logs and continues when continuation dispatch reports a delivery error", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(
      async (params: { onDispatchError: (err: unknown, info: { kind: string }) => void }) => {
        params.onDispatchError(new Error("route failed"), { kind: "final" });
      },
    );

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.logWarn.mock.calls[0]).toEqual([
      "restart continuation dispatch failed during final: Error: route failed",
      {
        sessionKey: "agent:main:main",
      },
    ]);
    expect(mocks.logWarn.mock.calls[1]?.[0]).toMatch(
      /^restart continuation: retry failed for entry [0-9a-f]{64}: route failed$/,
    );
  });

  it("retries restart continuations when the previous run is still shutting down", async () => {
    const busyReply = "⚠️ Previous run is still shutting down. Please try again in a moment.";
    let attempt = 0;
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.recordInboundSessionAndDispatchReply.mockImplementation(async (params) => {
      attempt += 1;
      if (attempt <= 2) {
        await params.deliver({ text: busyReply });
        return;
      }
      await params.deliver({
        text: "done",
        replyToId: String(params.ctxPayload.MessageSid),
      });
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectMockCallFields(mocks.enqueueSessionDelivery, {
      maxRetries: 20,
    });
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(3);
    expectContinuationDispatchFields(
      {},
      { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123" },
      0,
    );
    expectContinuationDispatchFields(
      {},
      { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123:retry:2" },
      2,
    );
    const deliveredBusyReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === busyReply) === true);
    expect(deliveredBusyReply).toBe(false);
    const deliveredFinalReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredFinalReply).toBe(false);
    expectRecordFields(lastMockCallArg(mocks.deliverOutboundPayloads), {
      payloads: [{ text: "restart message" }],
    });
    expect(mocks.logWarn).toHaveBeenCalledTimes(2);
    for (const [message] of mocks.logWarn.mock.calls) {
      expect(message).toMatch(
        /^restart continuation: retry failed for entry [0-9a-f]{64}: restart continuation deferred because previous run is still shutting down$/,
      );
    }
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("falls back to a session wake when restart routing cannot resolve a destination", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("missing route"),
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mockCallArg(mocks.enqueueSystemEvent, 1)).toBe("continue");
    expectNthSystemEventFields(1, {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(2);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("keeps the sentinel file when durable continuation handoff fails", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.enqueueSessionDelivery.mockRejectedValueOnce(new Error("queue write failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).not.toHaveBeenCalled();
    expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "queue write failed",
    });
  });

  it("consumes continuation once and does not replay it on later startup cycles", async () => {
    mocks.readRestartSentinel
      .mockResolvedValueOnce({
        payload: {
          sessionKey: "agent:main:main",
          deliveryContext: {
            channel: "whatsapp",
            to: "+15550002",
            accountId: "acct-2",
          },
          ts: 123,
          continuation: {
            kind: "agentTurn",
            message: "continue",
          },
        },
      } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>)
      .mockResolvedValueOnce(
        null as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>,
      );

    await scheduleRestartSentinelWake({ deps: {} as never });
    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
  });

  it("keeps a consumed update sentinel available for reconnect status polling", async () => {
    const payload: RestartSentinelPayload = {
      kind: "update",
      status: "ok",
      ts: 123,
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
      stats: {
        mode: "git",
        root: "/repo",
        before: { version: "1.0.0" },
        after: { version: "2.0.0" },
        steps: [],
        reason: null,
        durationMs: 10,
      },
    };
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload,
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledOnce();
    expect(getLatestUpdateRestartSentinel()).toEqual(payload);
  });

  it("does not rewrite pending update sentinels during status refresh", async () => {
    const payload: RestartSentinelPayload = {
      kind: "update",
      status: "skipped",
      ts: 123,
      stats: {
        mode: "git",
        handoffId: "handoff-1",
        reason: "managed-service-handoff-started",
      },
    };
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload,
    });

    await expect(refreshLatestUpdateRestartSentinel()).resolves.toEqual(payload);

    expect(mocks.finalizeUpdateRestartSentinelRunningVersion).not.toHaveBeenCalled();
    expect(getLatestUpdateRestartSentinel()).toEqual(payload);
  });

  it.each(["config-patch", "config-apply"] as const)(
    "consumes a targetless %s acknowledgement without waking an agent",
    async (kind) => {
      mocks.readRestartSentinel.mockResolvedValue({
        version: 1,
        revision: 123,
        payload: {
          kind,
          status: "ok",
          ts: 123,
          sessionKey: undefined,
          deliveryContext: undefined,
          threadId: undefined,
          message: null,
          doctorHint: "Run openclaw doctor --non-interactive",
          stats: {
            mode: kind === "config-patch" ? "config.patch" : "config.apply",
            root: "/tmp/openclaw.json",
            requiresRestart: true,
          },
        },
      });

      await scheduleRestartSentinelWake({ deps: {} as never });

      expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledOnce();
      expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledWith(123);
      expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
      expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
      expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit targetless config restart note", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        kind: "config-patch",
        status: "ok",
        ts: 123,
        message: "restart message",
        stats: { mode: "config.patch", requiresRestart: true },
      },
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledWith(123);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
  });

  it("delivers a session-less update notice only through the system main session route", async () => {
    const sessionKey = "agent:ops:main";
    const context = { channel: "telegram", to: "123", accountId: "bot", threadId: "7" };
    mocks.deliveryContextFromSession.mockReturnValue(context);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "123" });
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        kind: "update",
        status: "ok",
        ts: 123,
        continuation: { kind: "agentTurn", message: "must not continue an inferred session" },
      },
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "bot",
        threadId: "7",
        payloads: [{ text: "✅ OpenClaw updated and restarted." }],
      }),
    );
    const eventOptions = mocks.enqueueSystemEvent.mock.calls[0]?.[1];
    expect(eventOptions).toMatchObject({ sessionKey, deliveryContext: context });
    expect(resolveSystemEventOptionsOwnerAgentId(eventOptions as object)).toBe("ops");
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      agentId: "ops",
      sessionKey,
    });
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: continuation skipped: restart sentinel sessionKey unavailable",
      { sessionKey, continuationKind: "agentTurn" },
    );
  });

  it("durably wakes the configured system-agent session when the sentinel has no sessionKey", async () => {
    mocks.deliveryContextFromSession.mockReturnValue({ channel: "webchat", to: "agent:ops:main" });
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
        deliveryContext: { channel: "telegram", to: "another-conversation" },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    const eventOptions = mocks.enqueueSystemEvent.mock.calls[0]?.[1];
    expect(resolveSystemEventOptionsOwnerAgentId(eventOptions as object)).toBe("ops");
    expect(eventOptions).not.toHaveProperty("deliveryContext");
  });

  it("preserves system-agent ownership for a targetless global wake", async () => {
    mocks.resolveSystemMainSessionTarget.mockReturnValue({
      agentId: "ops",
      sessionKey: "global",
    });
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: { kind: "restart", status: "ok", ts: 123, message: "restart message" },
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    const eventOptions = mocks.enqueueSystemEvent.mock.calls[0]?.[1];
    expect(eventOptions).toMatchObject({ sessionKey: "global" });
    expect(resolveSystemEventOptionsOwnerAgentId(eventOptions as object)).toBe("ops");
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      agentId: "ops",
      sessionKey: "global",
    });
  });

  it("records targetless non-delivery when system-agent ownership is missing", async () => {
    mocks.resolveSystemMainSessionTarget.mockImplementation(() => {
      throw new Error(
        "Multiple agents are configured, but system-agent consult routing has no explicit owner. Set agents.defaults.systemAgent.agentId or pass an explicit consult agent id.",
      );
    });
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: { kind: "restart", status: "ok", ts: 123, message: "restart message" },
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.clearRestartSentinelIfRevision).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      reason: expect.stringContaining("Set agents.defaults.systemAgent.agentId"),
    });
  });

  it("warns when continuation cannot run because the restart sentinel has no sessionKey", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
        continuation: {
          kind: "agentTurn",
          message: "continue",
        },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({ sessionKey: "agent:ops:main" }),
    );
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.logWarn.mock.calls).toEqual([
      [
        "restart summary: continuation skipped: restart sentinel sessionKey unavailable",
        {
          sessionKey: "agent:ops:main",
          continuationKind: "agentTurn",
        },
      ],
    ]);
  });
  it("skips outbound restart notice when no canonical delivery context survives restart", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue(undefined);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: { sessionId: "agent:main:matrix:channel:!lowercased:example.org", updatedAt: 0 },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:matrix:channel:!lowercased:example.org",
      storeKeys: ["agent:main:matrix:channel:!lowercased:example.org"],
      legacyKey: undefined,
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mockCallArg(mocks.enqueueSystemEvent)).toBe("restart message");
    expectNthSystemEventFields(0, {
      sessionKey: "agent:main:matrix:channel:!lowercased:example.org",
    });
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
  });

  it("resolves session routing before queueing the heartbeat wake", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:qa-channel:channel:qa-room",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:qa-channel:channel:qa-room",
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    mocks.requestHeartbeat.mockImplementation(() => {
      mocks.deliveryContextFromSession.mockReturnValue({
        channel: "qa-channel",
        to: "heartbeat",
      });
    });
    mocks.resolveOutboundTarget.mockImplementation((params?: { to?: string }) => ({
      ok: true as const,
      to: params?.to ?? "missing",
    }));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
    expectMockCallFields(mocks.resolveOutboundTarget, {
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "qa-channel",
      to: "channel:qa-room",
    });
  });

  it("merges base session routing into partial thread metadata", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      threadId: "$thread-event",
    });
    mocks.loadSessionEntry
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          sessionId: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
          updatedAt: 0,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
            origin: { provider: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
          }),
        },
        store: {},
        storePath: "/tmp/sessions.json",
        canonicalKey: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
        storeKeys: ["agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event"],
        legacyKey: undefined,
      })
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          sessionId: "agent:main:matrix:channel:!lowercased:example.org",
          updatedAt: 0,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "room:!MixedCase:example.org" },
          }),
        },
        store: {},
        storePath: "/tmp/sessions.json",
        canonicalKey: "agent:main:matrix:channel:!lowercased:example.org",
        storeKeys: ["agent:main:matrix:channel:!lowercased:example.org"],
        legacyKey: undefined,
      });
    mocks.deliveryContextFromSession
      .mockReturnValueOnce({
        channel: "matrix",
        accountId: "acct-thread",
        threadId: "$thread-event",
      })
      .mockReturnValueOnce({ channel: "matrix", to: "room:!MixedCase:example.org" });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "room:!MixedCase:example.org",
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expectMockCallFields(mocks.resolveOutboundTarget, {
      channel: "matrix",
      to: "room:!MixedCase:example.org",
      accountId: "acct-thread",
    });
    expectMockCallFields(mocks.deliverOutboundPayloads, {
      channel: "matrix",
      to: "room:!MixedCase:example.org",
      accountId: "acct-thread",
      threadId: "$thread-event",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
