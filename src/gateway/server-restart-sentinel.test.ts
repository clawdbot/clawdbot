import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";

type LoadedSessionEntry = ReturnType<typeof import("./session-utils.js").loadSessionEntry>;
type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof import("../plugin-sdk/inbound-reply-dispatch.js").recordInboundSessionAndDispatchReply
>[0];

const mocks = vi.hoisted(() => {
  const state = {
    queuedSessionDelivery: null as Record<string, unknown> | null,
  };

  return {
    resolveSessionAgentId: vi.fn(() => "agent-from-key"),
    get queuedSessionDelivery() {
      return state.queuedSessionDelivery;
    },
    set queuedSessionDelivery(value: Record<string, unknown> | null) {
      state.queuedSessionDelivery = value;
    },
    readRestartSentinel: vi.fn(async () => ({
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      },
    })),
    removeRestartSentinelFile: vi.fn(async () => undefined),
    resolveRestartSentinelPath: vi.fn(() => "/tmp/restart-sentinel.json"),
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
    enqueueDelivery: vi.fn(async () => "queue-1"),
    ackDelivery: vi.fn(async () => {}),
    failDelivery: vi.fn(async () => {}),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    enqueueSessionDelivery: vi.fn(async (payload: Record<string, unknown>) => {
      state.queuedSessionDelivery = payload;
      return "session-delivery-1";
    }),
    drainPendingSessionDeliveries: vi.fn(
      async (params: {
        logLabel: string;
        log: { warn: (message: string) => void };
        selectEntry: (entry: Record<string, unknown>, now: number) => { match: boolean };
        deliver: (entry: Record<string, unknown>) => Promise<void>;
      }) => {
        if (!state.queuedSessionDelivery) {
          return;
        }
        const entry = {
          id: "session-delivery-1",
          enqueuedAt: 1,
          retryCount: 0,
          ...state.queuedSessionDelivery,
        };
        if (!params.selectEntry(entry, Date.now()).match) {
          return;
        }
        try {
          await params.deliver(entry);
        } catch (err) {
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
    injectTimestamp: vi.fn((message: string) => `stamped:${message}`),
    timestampOptsFromConfig: vi.fn(() => ({})),
    recordInboundSessionAndDispatchReply: vi.fn(
      async (_params: RecordInboundSessionAndDispatchReplyParams) => {},
    ),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.unmock("./server-restart-sentinel.js");
vi.resetModules();

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  readRestartSentinel: mocks.readRestartSentinel,
  removeRestartSentinelFile: mocks.removeRestartSentinelFile,
  resolveRestartSentinelPath: mocks.resolveRestartSentinelPath,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../infra/session-delivery-queue.js", () => ({
  enqueueSessionDelivery: mocks.enqueueSessionDelivery,
  drainPendingSessionDeliveries: mocks.drainPendingSessionDeliveries,
  recoverPendingSessionDeliveries: mocks.recoverPendingSessionDeliveries,
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

vi.mock("../plugin-sdk/inbound-reply-dispatch.js", () => ({
  recordInboundSessionAndDispatchReply: mocks.recordInboundSessionAndDispatchReply,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
    "../infra/heartbeat-wake.js",
  );
  return {
    ...actual,
    requestHeartbeatNow: mocks.requestHeartbeatNow,
  };
});

vi.mock("../logging/subsystem.js", () => {
  const logger = {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
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

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

describe("scheduleRestartSentinelWake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useRealTimers();
    mocks.queuedSessionDelivery = null;
    mocks.readRestartSentinel.mockResolvedValue({
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
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      entry: {
        sessionId: "agent:main:main",
        updatedAt: 0,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
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
    mocks.enqueueDelivery.mockReset();
    mocks.enqueueDelivery.mockResolvedValue("queue-1");
    mocks.ackDelivery.mockClear();
    mocks.failDelivery.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestHeartbeatNow.mockClear();
    mocks.enqueueSessionDelivery.mockClear();
    mocks.drainPendingSessionDeliveries.mockClear();
    mocks.recoverPendingSessionDeliveries.mockClear();
    mocks.removeRestartSentinelFile.mockClear();
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
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
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

  it("still dispatches continuation after restart notice retries are exhausted", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("transport still not ready"));
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
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never });
    await Promise.resolve();
    await Promise.resolve();
    for (let attempt = 1; attempt < 45; attempt += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await wakePromise;

    expect(mocks.failDelivery).toHaveBeenCalledWith("queue-1", "transport still not ready");
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        routeSessionKey: "agent:main:main",
        ctxPayload: expect.objectContaining({
          Body: "continue",
        }),
      }),
    );
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

  it("dispatches agentTurn continuation after the restart notice in the same routed thread", async () => {
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
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "restart message" }],
        threadId: "thread-42",
      }),
    );
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "acct-2",
        routeSessionKey: "agent:main:main",
        ctxPayload: expect.objectContaining({
          Body: "Reply with exactly: Yay! I did it!",
          BodyForAgent: "stamped:Reply with exactly: Yay! I did it!",
          BodyForCommands: "",
          CommandBody: "",
          CommandAuthorized: false,
          SessionKey: "agent:main:main",
          Provider: "whatsapp",
          Surface: "whatsapp",
          OriginatingChannel: "whatsapp",
          OriginatingTo: "+15550002",
          MessageThreadId: "thread-42",
        }),
      }),
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
      legacyKey: undefined,
    });
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "telegram:-1001" });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        routeSessionKey: "agent:main:group",
        ctxPayload: expect.objectContaining({
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-1001",
        }),
      }),
    );
  });

  it("preserves derived reply transport ids in continuation context", async () => {
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

    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        ctxPayload: expect.objectContaining({
          ReplyToId: "reply:thread-42",
          MessageThreadId: undefined,
        }),
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payloads: [
          {
            text: "done",
            replyToId: "reply:thread-42",
          },
        ],
      }),
    );
  });

  it("strips synthetic reply transport ids when no real reply target exists", async () => {
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
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payloads: [{ text: "done" }],
      }),
    );
  });

  it("preserves non-synthetic reply transport ids from continuation payloads", async () => {
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
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.deliver({
        text: "done",
        replyToId: "provider-reply-id",
      });
    });

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.deliverOutboundPayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payloads: [
          {
            text: "done",
            replyToId: "provider-reply-id",
          },
        ],
      }),
    );
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

    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "default",
        ctxPayload: expect.objectContaining({
          Body: "continue",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:200482621",
        }),
      }),
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

    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(
      2,
      "continue after restart",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliveryContext: expect.objectContaining({
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "thread-42",
        }),
      }),
    );
    expect(mocks.requestHeartbeatNow).toHaveBeenNthCalledWith(1, {
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeatNow).toHaveBeenNthCalledWith(2, {
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

    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(
      2,
      "continue after restart",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliveryContext: expect.objectContaining({
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "thread-42",
        }),
      }),
    );
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

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("retry failed for entry session-delivery-1: Error: dispatch failed"),
    );
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

    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("retry failed for entry session-delivery-1: Error: route failed"),
    );
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
    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(
      2,
      "continue",
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledTimes(2);
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

    expect(mocks.removeRestartSentinelFile).not.toHaveBeenCalled();
    expect(mocks.drainPendingSessionDeliveries).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "startup task failed",
      expect.objectContaining({
        source: "restart-sentinel",
        sessionKey: "agent:main:main",
        reason: "queue write failed",
      }),
    );
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

  it("does not wake the main session when the sentinel has no sessionKey", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
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
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("continuation skipped"),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        continuationKind: "agentTurn",
      }),
    );
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
