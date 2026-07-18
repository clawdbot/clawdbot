// Restart sentinel tests protect queued post-restart delivery recovery and the
// session/channel context used when the gateway resumes an interrupted run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";

type RestartSentinel = NonNullable<
  Awaited<ReturnType<typeof import("../infra/restart-sentinel.js").readRestartSentinel>>
>;

type LoadedSessionEntry = ReturnType<typeof import("./session-utils.js").loadSessionEntry>;
type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof import("../channels/turn/kernel.js").dispatchAssembledChannelTurn
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
  typeof import("../infra/session-delivery-queue.js").advanceSessionDeliveryAgentRun;

const mocks = vi.hoisted(() => {
  const state = {
    queuedSessionDeliveries: new Map<string, Record<string, unknown>>(),
    nextSessionDeliveryId: 1,
  };

  return {
    resolveSessionAgentId: vi.fn(() => "agent-from-key"),
    get queuedSessionDelivery() {
      return state.queuedSessionDeliveries.values().next().value ?? null;
    },
    set queuedSessionDelivery(value: Record<string, unknown> | null) {
      state.queuedSessionDeliveries.clear();
      state.nextSessionDeliveryId = 1;
      if (value) {
        state.queuedSessionDeliveries.set("session-delivery-1", value);
        state.nextSessionDeliveryId = 2;
      }
    },
    dispatchGatewayMethodInProcess: vi.fn<InProcessDispatchMock>(async () => ({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "sent" },
      },
    })),
    readRestartSentinel: vi.fn(
      async (): Promise<RestartSentinel> => ({
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
      }),
    ),
    finalizeUpdateRestartSentinelRunningVersion: vi.fn(async () => null),
    clearRestartSentinelIfRevision: vi.fn(async () => true),
    formatRestartSentinelMessage: vi.fn(() => "restart message"),
    summarizeRestartSentinel: vi.fn(() => "restart summary"),
    resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
    parseSessionThreadInfo: vi.fn(
      (): { baseSessionKey: string | null | undefined; threadId: string | undefined } => ({
        baseSessionKey: null,
        threadId: undefined,
      }),
    ),
    loadSessionEntry: vi.fn(
      (): LoadedSessionEntry => ({
        cfg: {},
        entry: {
          sessionId: "agent:main:main",
          updatedAt: 0,
        },
        store: {},
        storePath: "/tmp/sessions.json",
        canonicalKey: "agent:main:main",
        storeKeys: ["agent:main:main"],
        legacyKey: undefined,
      }),
    ),
    deliveryContextFromSession: vi.fn(
      ():
        | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
        | undefined => undefined,
    ),
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
    deliverOutboundPayloads: vi.fn(async () => [{ channel: "whatsapp", messageId: "msg-1" }]),
    enqueueDeliveryOnce: vi.fn(async (_payload: unknown, id: string) => ({ id, created: true })),
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
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    enqueueSessionDelivery: vi.fn(async (payload: Record<string, unknown>) => {
      const existing = [...state.queuedSessionDeliveries.entries()].find(
        ([, entry]) => entry.idempotencyKey === payload.idempotencyKey,
      );
      if (existing) {
        return existing[0];
      }
      const id = `session-delivery-${state.nextSessionDeliveryId++}`;
      state.queuedSessionDeliveries.set(id, payload);
      return id;
    }),
    ackSessionDelivery: vi.fn(async () => {}),
    advanceSessionDeliveryAgentRun: vi.fn<AdvanceSessionDeliveryAgentRunMock>(async () => {}),
    deferSessionDelivery: vi.fn(async () => {}),
    failSessionDelivery: vi.fn(async () => {}),
    markSessionDeliveryAttemptStarted: vi.fn(async () => {}),
    moveSessionDeliveryToFailed: vi.fn(async () => {}),
    markSessionDeliverySettlement: vi.fn(async () => {}),
    appendAssistantMessageToSessionTranscript: vi.fn(async () => ({
      ok: true as const,
      sessionFile: "/tmp/session.jsonl",
      messageId: "generated-media-transcript",
    })),
    removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
    loadPendingSessionDelivery: vi.fn(
      async (id: string) => state.queuedSessionDeliveries.get(id) ?? null,
    ),
    drainPendingSessionDeliveries: vi.fn(
      async (params: {
        logLabel: string;
        log: { warn: (message: string) => void };
        selectEntry: (entry: Record<string, unknown>, now: number) => { match: boolean };
        deliver: (entry: Record<string, unknown>) => Promise<void>;
      }) => {
        const selected = [...state.queuedSessionDeliveries.entries()]
          .map(([id, payload]) => ({ id, payload }))
          .find(
            ({ id, payload }) =>
              params.selectEntry({ id, enqueuedAt: 1, retryCount: 0, ...payload }, Date.now())
                .match,
          );
        if (!selected) {
          return;
        }
        const entry: Record<string, unknown> & {
          id: string;
          enqueuedAt: number;
          retryCount: number;
        } = {
          id: selected.id,
          enqueuedAt: 1,
          retryCount: 0,
          ...selected.payload,
        };
        const maxRetries = typeof entry["maxRetries"] === "number" ? entry["maxRetries"] : 5;
        if (entry.retryCount >= maxRetries) {
          state.queuedSessionDeliveries.delete(entry.id);
          params.log.warn(
            `${params.logLabel}: entry ${entry.id} exceeded max retries and was moved to failed/`,
          );
          return;
        }
        try {
          await params.deliver(entry);
          state.queuedSessionDeliveries.delete(entry.id);
        } catch (err) {
          state.queuedSessionDeliveries.set(entry.id, {
            ...entry,
            retryCount: entry.retryCount + 1,
            lastError: err instanceof Error ? err.message : String(err),
          });
          params.log.warn(`${params.logLabel}: retry failed for entry ${entry.id}: ${String(err)}`);
        }
      },
    ),
    recoverPendingSessionDeliveries: vi.fn(async () => ({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    })),
    resolveAgentConfig: vi.fn(() => undefined),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-test-workspace"),
    resolveDefaultAgentId: vi.fn(() => "main"),
    normalizeSessionDeliveryFields: vi.fn((source?: Record<string, unknown>) => ({
      deliveryContext: source?.deliveryContext,
      lastChannel: source?.lastChannel ?? source?.channel,
      lastTo: source?.lastTo,
      lastAccountId: source?.lastAccountId,
      lastThreadId: source?.lastThreadId,
    })),
    injectTimestamp: vi.fn((message: string) => `stamped:${message}`),
    timestampOptsFromConfig: vi.fn(() => ({})),
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

vi.mock("../infra/restart-sentinel.js", () => ({
  finalizeUpdateRestartSentinelRunningVersion: mocks.finalizeUpdateRestartSentinelRunningVersion,
  readRestartSentinel: mocks.readRestartSentinel,
  clearRestartSentinelIfRevision: mocks.clearRestartSentinelIfRevision,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../infra/session-delivery-queue.js", () => ({
  ackSessionDelivery: mocks.ackSessionDelivery,
  advanceSessionDeliveryAgentRun: mocks.advanceSessionDeliveryAgentRun,
  deferSessionDelivery: mocks.deferSessionDelivery,
  failSessionDelivery: mocks.failSessionDelivery,
  enqueueSessionDelivery: mocks.enqueueSessionDelivery,
  loadPendingSessionDelivery: mocks.loadPendingSessionDelivery,
  markSessionDeliveryAttemptStarted: mocks.markSessionDeliveryAttemptStarted,
  moveSessionDeliveryToFailed: mocks.moveSessionDeliveryToFailed,
  markSessionDeliverySettlement: mocks.markSessionDeliverySettlement,
  drainPendingSessionDeliveries: mocks.drainPendingSessionDeliveries,
  recoverPendingSessionDeliveries: mocks.recoverPendingSessionDeliveries,
  SessionDeliveryDeadLetteredError: class SessionDeliveryDeadLetteredError extends Error {},
  SessionDeliveryDeferredError: class SessionDeliveryDeferredError extends Error {},
  SessionDeliverySafeRetryError: class SessionDeliverySafeRetryError extends Error {},
}));

vi.mock("../tasks/cron-run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: mocks.removeCronRunContinuationSessionIfIdle,
}));

vi.mock("../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfoFast: mocks.parseSessionThreadInfo,
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../utils/delivery-context.shared.js", () => ({
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
  normalizeSessionDeliveryFields: mocks.normalizeSessionDeliveryFields,
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

vi.mock("../channels/turn/kernel.js", () => ({
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

vi.mock("./server-plugins.js", () => ({
  dispatchGatewayMethodInProcess: mocks.dispatchGatewayMethodInProcess,
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  enqueueDeliveryOnce: mocks.enqueueDeliveryOnce,
  ackDelivery: mocks.ackDelivery,
  failDelivery: mocks.failDelivery,
  failDeliveryAfterPlatformSend: mocks.failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend: mocks.failDeliveryBeforePlatformSend,
  drainPendingDeliveries: mocks.drainPendingDeliveries,
  withActiveDeliveryClaim: mocks.withActiveDeliveryClaim,
}));

vi.mock("../infra/outbound/delivery-queue-storage.js", () => ({
  failPendingDelivery: mocks.failPendingDelivery,
  loadPendingDelivery: mocks.loadPendingDelivery,
  reserveDeliveryAttempt: mocks.reserveDeliveryAttempt,
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

vi.mock("../logging/subsystem.js", () => {
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
    createSubsystemLogger: vi.fn(() => logger),
  };
});

vi.mock("./server-methods/agent-timestamp.js", () => ({
  injectTimestamp: mocks.injectTimestamp,
  timestampOptsFromConfig: mocks.timestampOptsFromConfig,
}));

const {
  deliverQueuedSessionDelivery,
  getLatestUpdateRestartSentinel,
  refreshLatestUpdateRestartSentinel,
  scheduleRestartSentinelWake,
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

describe("scheduleRestartSentinelWake", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    mocks.queuedSessionDelivery = null;
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
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        updatedAt: 0,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });
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
    mocks.ackSessionDelivery.mockClear();
    mocks.advanceSessionDeliveryAgentRun.mockClear();
    mocks.deferSessionDelivery.mockClear();
    mocks.failSessionDelivery.mockClear();
    mocks.markSessionDeliveryAttemptStarted.mockClear();
    mocks.moveSessionDeliveryToFailed.mockClear();
    mocks.markSessionDeliverySettlement.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.removeCronRunContinuationSessionIfIdle.mockClear();
    mocks.loadPendingSessionDelivery.mockClear();
    mocks.drainPendingSessionDeliveries.mockClear();
    mocks.recoverPendingSessionDeliveries.mockClear();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockResolvedValue(null);
    mocks.clearRestartSentinelIfRevision.mockReset();
    mocks.clearRestartSentinelIfRevision.mockResolvedValue(true);
    mocks.formatRestartSentinelMessage.mockClear();
    mocks.summarizeRestartSentinel.mockClear();
    mocks.injectTimestamp.mockClear();
    mocks.timestampOptsFromConfig.mockClear();
    mocks.recordInboundSessionAndDispatchReply.mockReset();
    mocks.recordInboundSessionAndDispatchReply.mockResolvedValue(undefined);
    mocks.logInfo.mockClear();
    mocks.logWarn.mockClear();
    mocks.logError.mockClear();
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
    mocks.enqueueDeliveryOnce.mockImplementationOnce(async (_payload, id) => ({
      id,
      created: false,
    }));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledWith(123);
    expect(mocks.enqueueDeliveryOnce.mock.calls[0]?.[1]).toBe(
      "restart-sentinel-notice:agent:main:main:123",
    );
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
    const drain = expectRecordFields(mockCallArg(mocks.drainPendingDeliveries), {
      drainKey: "restart-recovery:restart-sentinel-notice:agent:main:main:123",
      deliver: expect.any(Function),
    });
    const selectEntry = drain.selectEntry as (entry: { id: string }) => {
      match: boolean;
      bypassBackoff?: boolean;
    };
    expect(selectEntry({ id: "restart-sentinel-notice:agent:main:main:123" })).toEqual({
      match: true,
      bypassBackoff: true,
    });
    expect(selectEntry({ id: "other" })).toEqual({ match: false, bypassBackoff: true });
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

  it("starts a terminal drain when the persisted retry budget is exhausted", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("transport unavailable"));
    mocks.loadPendingDelivery.mockResolvedValue({
      id: "restart-sentinel-notice:agent:main:main:123",
      retryCount: 45,
      attemptCount: 45,
      lastError: "transport unavailable",
    } as never);
    mocks.drainPendingDeliveries.mockImplementationOnce(async () => {
      mocks.loadPendingDelivery.mockResolvedValue(null);
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
  });

  it("preserves a notice whose persisted retry budget is not exhausted", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("transport unavailable"));
    mocks.loadPendingDelivery.mockResolvedValue({
      id: "restart-sentinel-notice:agent:main:main:123",
      retryCount: 7,
      lastError: "database busy",
    } as never);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.drainPendingDeliveries).toHaveBeenCalledTimes(46);
    expect(mocks.failPendingDelivery).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "restart summary: restart notice remains queued after bounded recovery",
      {
        queueId: "restart-sentinel-notice:agent:main:main:123",
        sessionKey: "agent:main:main",
        retryCount: 7,
        attemptCount: null,
        maxAttempts: 45,
      },
    );
  });

  it("continues exact-id recovery after another owner releases the notice", async () => {
    mocks.withActiveDeliveryClaim.mockResolvedValueOnce({
      status: "claimed-by-other-owner",
    } as never);
    mocks.loadPendingDelivery
      .mockResolvedValueOnce({
        id: "restart-sentinel-notice:agent:main:main:123",
        retryCount: 0,
      } as never)
      .mockResolvedValue(null);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "restart summary: durable restart notice claimed by recovery",
      { sessionKey: "agent:main:main" },
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

  it("keeps one queued restart notice when outbound delivery fails", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("transport still not ready"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueDeliveryOnce).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).toHaveBeenCalledWith(
      "restart-sentinel-notice:agent:main:main:123",
      "transport still not ready",
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
    mocks.readRestartSentinel.mockResolvedValue({
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
          message: "Reply with exactly: Yay! I did it!",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
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
      expect.objectContaining({ id: "session-delivery-1", kind: "agentTurn" }),
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
    await deliverQueuedSessionDelivery({
      deps: {} as never,
      stateDir: "/tmp/custom-session-delivery-state",
      entry: {
        id: "session-delivery-media",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-1:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          chatType: "channel",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "image_generate:task-1",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "message_tool_only",
        expectedMediaUrls: ["/tmp/proof.png"],
        idempotencyKey: "image:task-1:agent-loop",
      },
    });

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
          sourceChannel: "webchat",
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-pre-accept",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-pre-accept:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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

    await deliverQueuedSessionDelivery({
      deps: {} as never,
      entry: {
        id: "session-delivery-cron-media",
        kind: "agentTurn",
        sessionKey: "agent:main:cron:daily-media:run:run-123",
        message: "generated image ready",
        messageId: "image:cron-task:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: { channel: "discord", to: "channel:123", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: ["/tmp/proof.png"],
        suppressTextDelivery: true,
      },
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-owned",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-owned:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("still owned by agent recovery");

    expect(mocks.deferSessionDelivery).toHaveBeenCalledWith("session-delivery-media-owned", 1_000);
  });

  it("retains the local fence when gateway dedupe reports another in-flight owner", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({ status: "in_flight" });

    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-in-flight",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-in-flight:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-terminal",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-terminal:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered without durable terminal evidence");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-terminal-empty",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generation completed",
          messageId: "image:task-terminal-empty:agent-loop",
          enqueuedAt: 1,
          retryCount: 1,
          lastChargedAgentRunAttempt: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: [],
        },
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
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-terminal-missing",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-terminal-missing:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
  });

  it("dead-letters an interrupted attempt without durable agent evidence", async () => {
    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-interrupted-unproven",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-interrupted-unproven:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          deliveryStartedAt: 2,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-terminal-private",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-terminal-private:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
  });

  it("asks the normal agent loop to deliver automatic generated-media replies", async () => {
    await deliverQueuedSessionDelivery({
      deps: {} as never,
      entry: {
        id: "session-delivery-media-automatic",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-automatic:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          chatType: "channel",
        },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: ["/tmp/proof.png"],
        suppressTextDelivery: true,
      },
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

    await deliverQueuedSessionDelivery({
      deps: {} as never,
      entry: {
        id: "session-delivery-media-normalized",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-normalized:agent-loop",
        idempotencyKey: "image:task-normalized:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: { channel: "discord", to: "channel:123", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: ["file:///tmp/generated%20image.png"],
      },
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.failSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.deferSessionDelivery).not.toHaveBeenCalled();
  });

  it("accepts a generated-media reply committed only to the owning transcript", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
      },
    });

    await deliverQueuedSessionDelivery({
      deps: {} as never,
      entry: {
        id: "session-delivery-media-internal",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-internal:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: ["/tmp/proof.png"],
      },
    });

    expect(mocks.dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ deliver: false, sourceReplyDeliveryMode: "automatic" }),
      {
        expectFinal: true,
        forceSyntheticClient: true,
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        onAccepted: expect.any(Function),
      },
    );
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      expectedSessionId: "agent:main:main",
      mediaUrls: ["/tmp/proof.png"],
      idempotencyKey: "image:task-internal:agent-loop:generated-media-transcript",
      updateMode: "inline",
    });
    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
  });

  it("persists proven internal media before retrying the missing subset", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: { payloads: [{ text: "first ready", mediaUrls: ["/tmp/one.png"] }] },
    });

    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-internal-partial",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated images ready",
          messageId: "image:task-internal-partial:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        },
      }),
    ).rejects.toThrow("partially missed expected media: /tmp/two.png");

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrls: ["/tmp/one.png"],
        idempotencyKey: "image:task-internal-partial:agent-loop:generated-media-transcript",
      }),
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-internal-reasoning",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-internal-reasoning:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "webchat", to: "agent:main:main", chatType: "direct" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-internal-reasoning",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
    );
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-missing",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-missing:agent-loop",
          idempotencyKey: "image:task-missing:agent-loop",
          enqueuedAt: 1,
          retryCount: 2,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-hidden-aggregate",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-hidden-aggregate:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-hidden-aggregate",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/proof.png"] }),
    );
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
  });

  it("accepts suppressed automatic media as a committed durable delivery", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "suppressed" },
      },
    });

    await deliverQueuedSessionDelivery({
      deps: {} as never,
      entry: {
        id: "session-delivery-media-suppressed",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-suppressed:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: { channel: "discord", to: "channel:123", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: ["/tmp/proof.png"],
      },
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
  });

  it("accepts a suppressed visible automatic completion notice", async () => {
    mocks.dispatchGatewayMethodInProcess.mockResolvedValueOnce({
      status: "ok",
      result: {
        payloads: [{ text: "generation failed" }],
        deliveryStatus: { status: "suppressed" },
      },
    });

    await deliverQueuedSessionDelivery({
      deps: {} as never,
      entry: {
        id: "session-delivery-notice-suppressed",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "generation failed",
        messageId: "image:task-notice-suppressed:agent-loop",
        enqueuedAt: 1,
        retryCount: 0,
        route: { channel: "discord", to: "channel:123", chatType: "channel" },
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "webchat",
          sourceTool: "image_generate",
        },
        sourceReplyDeliveryMode: "automatic",
        expectedMediaUrls: [],
      },
    });

    expect(mocks.advanceSessionDeliveryAgentRun).not.toHaveBeenCalled();
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-partial-safe",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated images ready",
          messageId: "image:task-partial-safe:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        },
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-cross-path-partial",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated images ready",
          messageId: "image:task-cross-path-partial:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        },
      }),
    ).rejects.toThrow("missed expected media: /tmp/two.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-media-cross-path-partial",
      expect.objectContaining({ expectedMediaUrls: ["/tmp/two.png"] }),
    );
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-caption-ambiguous",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-caption-ambiguous:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-hidden-automatic",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated images ready",
          messageId: "image:task-hidden-automatic:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
        },
      }),
    ).rejects.toThrow("completed without a visible reply");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalledWith(
      "session-delivery-hidden-automatic",
    );
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-text-only",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-text-only:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("missed expected media: /tmp/proof.png");

    expect(mocks.advanceSessionDeliveryAgentRun).toHaveBeenCalled();
    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-partial-unclassified",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-partial-unclassified:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after ambiguous side effects");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-truncated",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-truncated:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after truncated evidence");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-tool-targets-truncated",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-tool-targets-truncated:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-tool-aggregate-only",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-tool-aggregate-only:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-tool-mixed-aggregate",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated images ready",
          messageId: "image:task-tool-mixed-aggregate:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-wrong-target",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-wrong-target:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-unsafe-side-effect",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-unsafe-side-effect:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after an unexpected committed side effect");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "session-delivery-media-partial",
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated images ready",
          messageId: "image:task-partial:agent-loop",
          enqueuedAt: 1,
          retryCount: 0,
          route: { channel: "discord", to: "channel:123", chatType: "channel" },
          inputProvenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "automatic",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        },
      }),
    ).rejects.toThrow("dead-lettered after ambiguous side effects");

    expect(mocks.moveSessionDeliveryToFailed).not.toHaveBeenCalled();
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
    mocks.readRestartSentinel.mockResolvedValue({
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
      queueId: "session-delivery-1",
      expectedSessionId: "old-session-id",
      actualSessionId: "new-session-id",
    });
  });

  it("still delivers systemEvent continuations for completed run entries", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
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
          kind: "systemEvent",
          text: "continue after restart",
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
        origin: { provider: "telegram", chatType: "group" },
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
        origin: { provider: "telegram", chatType: "group" },
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
    mocks.readRestartSentinel.mockResolvedValue({
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
          message: "continue",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
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
    mocks.readRestartSentinel.mockResolvedValue({
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
          kind: "systemEvent",
          text: "continue after restart",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

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
    mocks.readRestartSentinel.mockResolvedValue({
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
          kind: "systemEvent",
          text: "continue after restart",
        },
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
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
    mocks.readRestartSentinel.mockResolvedValue({
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
    mocks.recordInboundSessionAndDispatchReply.mockRejectedValueOnce(new Error("dispatch failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.logWarn.mock.calls).toEqual([
      ["restart continuation: retry failed for entry session-delivery-1: Error: dispatch failed"],
    ]);
  });

  it("logs and continues when continuation dispatch reports a delivery error", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
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
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(
      async (params: { onDispatchError: (err: unknown, info: { kind: string }) => void }) => {
        params.onDispatchError(new Error("route failed"), { kind: "final" });
      },
    );

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.logWarn.mock.calls).toEqual([
      [
        "restart continuation dispatch failed during final: Error: route failed",
        {
          sessionKey: "agent:main:main",
        },
      ],
      ["restart continuation: retry failed for entry session-delivery-1: Error: route failed"],
    ]);
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
    expect(mocks.logWarn.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        "restart continuation: retry failed for entry session-delivery-1: Error: restart continuation deferred because previous run is still shutting down",
      ]),
    );
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("falls back to a session wake when restart routing cannot resolve a destination", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
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
    mocks.readRestartSentinel.mockResolvedValue({
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
    mocks.enqueueSessionDelivery.mockRejectedValueOnce(new Error("queue write failed"));

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.clearRestartSentinelIfRevision).not.toHaveBeenCalled();
    expect(mocks.drainPendingSessionDeliveries).not.toHaveBeenCalled();
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

  it("durably wakes the main session when the sentinel has no sessionKey", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
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

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.logWarn.mock.calls).toEqual([
      [
        "restart summary: continuation skipped: restart sentinel sessionKey unavailable",
        {
          sessionKey: "agent:main:main",
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
          origin: { provider: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
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
          lastChannel: "matrix",
          lastTo: "room:!MixedCase:example.org",
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
