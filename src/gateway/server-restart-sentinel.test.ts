import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  consumeRestartSentinel: vi.fn(async () => ({
    payload: {
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "whatsapp",
        to: "+15550002",
        accountId: "acct-2",
      },
    },
  })),
  formatRestartSentinelMessage: vi.fn(() => "restart message"),
  summarizeRestartSentinel: vi.fn(() => "restart summary"),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  parseSessionThreadInfo: vi.fn(
    (): { baseSessionKey: string | null | undefined; threadId: string | undefined } => ({
      baseSessionKey: null,
      threadId: undefined,
    }),
  ),
  loadSessionEntry: vi.fn(() => ({ cfg: {}, entry: {} })),
  deliveryContextFromSession: vi.fn(
    ():
      | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
      | undefined => undefined,
  ),
  mergeDeliveryContext: vi.fn((a?: Record<string, unknown>, b?: Record<string, unknown>) => ({
    ...b,
    ...a,
  })),
  getChannelPlugin: vi.fn(() => undefined),
  normalizeChannelId: vi.fn((channel: string) => channel),
  resolveOutboundTarget: vi.fn((_params?: { to?: string }) => ({
    ok: true as const,
    to: "+15550002",
  })),
  deliverOutboundPayloads: vi.fn(async () => [{ channel: "whatsapp", messageId: "msg-1" }]),
  enqueueDelivery: vi.fn(async () => "queue-1"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
  enqueueSystemEvent: vi.fn(),
  requestHeartbeatNow: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: mocks.consumeRestartSentinel,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../utils/delivery-context.shared.js", () => ({
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
  ackDelivery: mocks.ackDelivery,
  failDelivery: mocks.failDelivery,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow: mocks.requestHeartbeatNow,
    }),
  );
});

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
  })),
}));

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

describe("scheduleRestartSentinelWake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useRealTimers();
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
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
    mocks.loadSessionEntry.mockReturnValue({ cfg: {}, entry: {} });
    mocks.deliveryContextFromSession.mockReset();
    mocks.deliveryContextFromSession.mockReturnValue(undefined);
    mocks.resolveOutboundTarget.mockReset();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "+15550002" });
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]);
    mocks.enqueueDelivery.mockReset();
    mocks.enqueueDelivery.mockResolvedValue("queue-1");
    mocks.ackDelivery.mockClear();
    mocks.failDelivery.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestHeartbeatNow.mockClear();
    mocks.logWarn.mockClear();
  });

  it("enqueues the sentinel note and wakes the session even when outbound delivery succeeds", async () => {
    const deps = {} as never;

    await scheduleRestartSentinelWake({ deps });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        session: { key: "agent:main:main", agentId: "agent-from-key" },
        deps,
        bestEffort: false,
        skipQueue: true,
      }),
    );
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        payloads: [{ text: "restart message" }],
        bestEffort: false,
      }),
    );
    expect(mocks.ackDelivery).toHaveBeenCalledWith("queue-1");
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("retries outbound delivery once and logs a warning without dropping the agent wake", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("transport not ready"))
      .mockResolvedValueOnce([{ channel: "whatsapp", messageId: "msg-2" }]);

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await wakePromise;

    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(mocks.deliverOutboundPayloads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        skipQueue: true,
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        skipQueue: true,
      }),
    );
    expect(mocks.ackDelivery).toHaveBeenCalledWith("queue-1");
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 1000ms"),
      expect.objectContaining({
        channel: "whatsapp",
        to: "+15550002",
        sessionKey: "agent:main:main",
        attempt: 1,
        maxAttempts: 45,
      }),
    );
  });

  it("keeps one queued restart notice when outbound retries are exhausted", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("transport still not ready"));

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never });
    await Promise.resolve();
    await Promise.resolve();
    for (let attempt = 1; attempt < 45; attempt += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await wakePromise;

    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(45);
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).toHaveBeenCalledWith("queue-1", "transport still not ready");
  });

  it("prefers top-level sentinel threadId for wake routing context", async () => {
    // Legacy or malformed sentinel JSON can still carry a nested threadId.
    mocks.consumeRestartSentinel.mockResolvedValue({
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
    } as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliveryContext: expect.objectContaining({
          threadId: "fresh-thread",
        }),
      }),
    );
  });

  it("does not wake the main session when the sentinel has no sessionKey", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips outbound restart notice when no canonical delivery context survives restart", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      },
    } as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue(undefined);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      }),
    );
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
  });

  it("resolves session routing before queueing the heartbeat wake", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:qa-channel:channel:qa-room",
      },
    } as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:qa-channel:channel:qa-room",
      threadId: undefined,
    });
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "qa-channel",
      to: "channel:qa-room",
    });
    mocks.requestHeartbeatNow.mockImplementation(() => {
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

    expect(mocks.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "qa-channel",
        to: "channel:qa-room",
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "qa-channel",
        to: "channel:qa-room",
      }),
    );
  });

  it("merges base session routing into partial thread metadata", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:matrix:channel:!lowercased:example.org:thread:$thread-event",
      },
    } as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:matrix:channel:!lowercased:example.org",
      threadId: "$thread-event",
    });
    mocks.loadSessionEntry
      .mockReturnValueOnce({
        cfg: {},
        entry: {
          origin: { provider: "matrix", accountId: "acct-thread", threadId: "$thread-event" },
        },
      })
      .mockReturnValueOnce({
        cfg: {},
        entry: { lastChannel: "matrix", lastTo: "room:!MixedCase:example.org" },
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

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: "acct-thread",
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: "acct-thread",
        threadId: "$thread-event",
      }),
    );
  });
});
