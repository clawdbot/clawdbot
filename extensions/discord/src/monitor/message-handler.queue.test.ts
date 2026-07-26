// Discord tests cover message handler.queue plugin behavior.
import { getEventListeners } from "node:events";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageHandler as createDurableDiscordMessageHandler } from "./message-handler.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

type SetStatusFn = (patch: Record<string, unknown>) => void;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
function mockCalls(source: MockCallSource): Array<Array<unknown>> {
  return source.mock.calls;
}

function statusPatches(setStatus: MockCallSource) {
  return setStatus.mock.calls.map(([patch]) => patch as Record<string, unknown>);
}

function expectStatusPatch(setStatus: MockCallSource, expected: Record<string, unknown>) {
  expect(
    statusPatches(setStatus).some((patch) =>
      Object.entries(expected).every(([key, value]) => patch[key] === value),
    ),
  ).toBe(true);
}

function createDeferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createIngressLifecycle(): DiscordIngressLifecycle & {
  onAdopted: ReturnType<typeof vi.fn>;
  onAbandoned: ReturnType<typeof vi.fn>;
} {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
  };
}

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function createMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [{ id: `att-${messageId}` }],
    },
  };
}

function createTextMessageData(messageId: string, channelId = "ch-1") {
  const data = createMessageData(messageId, channelId);
  data.message.attachments = [];
  return data;
}

function createPreflightContext(channelId = "ch-1") {
  const discordConfig = {
    enabled: true,
    token: "test-token",
    groupPolicy: "allowlist" as const,
  };
  const cfg: OpenClawConfig = {
    channels: {
      discord: discordConfig,
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    ...createDiscordPreflightContext(channelId),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
    messageText: "hello",
    isDirectMessage: false,
    isGuildMessage: true,
    isGroupDm: false,
    inboundEventKind: "message" as const,
    effectiveWasMentioned: false,
  };
}

function createHandlerWithDefaultPreflight(overrides?: { setStatus?: SetStatusFn }) {
  preflightDiscordMessageMock.mockImplementation(async (params: { data: { channel_id: string } }) =>
    createPreflightContext(params.data.channel_id),
  );
  return createDiscordMessageHandler(createDiscordHandlerParams(overrides));
}

function installDefaultDiscordPreflight() {
  preflightDiscordMessageMock.mockImplementation(async (params: { data: { channel_id: string } }) =>
    createPreflightContext(params.data.channel_id),
  );
}

async function createLifecycleStopScenario(params: {
  createHandler: (status: SetStatusFn) => {
    handler: (data: never, opts: never) => Promise<unknown>;
    stop: () => void | Promise<void>;
  };
}) {
  preflightDiscordMessageMock.mockImplementation(
    async (preflightParams: { data: { channel_id: string } }) =>
      createPreflightContext(preflightParams.data.channel_id),
  );
  const runInFlight = createDeferred();
  processDiscordMessageMock.mockImplementation(async () => {
    await runInFlight.promise;
  });

  const setStatus = vi.fn<SetStatusFn>();
  const { handler, stop } = params.createHandler(setStatus);

  await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
  await flushQueueWork();
  expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

  const callsBeforeStop = setStatus.mock.calls.length;
  const stopTask = stop();

  return {
    setStatus,
    callsBeforeStop,
    finish: async () => {
      runInFlight.resolve();
      await runInFlight.promise;
      await stopTask;
      await Promise.resolve();
    },
  };
}

describe("createDiscordMessageHandler queue behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resets busy counters when the handler is created", () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const setStatus = vi.fn();
    createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    expectStatusPatch(setStatus, { activeRuns: 0, busy: false });
  });

  it("returns immediately and tracks busy status while queued runs execute", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred();
    const secondRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
      })
      .mockImplementationOnce(async () => {
        await secondRun.promise;
      });
    const setStatus = vi.fn();
    const handler = createHandlerWithDefaultPreflight({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expectStatusPatch(setStatus, { activeRuns: 1, busy: true });

    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstRun.resolve();
    await firstRun.promise;

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);

    secondRun.resolve();
    await secondRun.promise;

    await flushQueueWork();
    const lastStatusPatch = statusPatches(setStatus).at(-1);
    expect(lastStatusPatch?.activeRuns).toBe(0);
    expect(lastStatusPatch?.busy).toBe(false);
  });

  it("fans merged-turn adoption out to every debounced ingress claim", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: {
        data: { channel_id: string };
        turnAdoptionLifecycle?: unknown;
      }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
      }),
    );
    processDiscordMessageMock.mockImplementation(
      async (ctx: { turnAdoptionLifecycle?: DiscordIngressLifecycle }) => {
        await ctx.turnAdoptionLifecycle?.onAdopted();
      },
    );
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();

    await expect(
      handler(createTextMessageData("m-fanout-1") as never, {} as never, {
        turnAdoptionLifecycle: first,
      }),
    ).resolves.toEqual({ kind: "deferred" });
    await expect(
      handler(createTextMessageData("m-fanout-2") as never, {} as never, {
        turnAdoptionLifecycle: second,
      }),
    ).resolves.toEqual({ kind: "deferred" });

    await vi.waitFor(() => expect(processDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("completes every debounced ingress claim when preflight gates the merged turn", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(null);
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    const handler = createDiscordMessageHandler(params);
    const first = createIngressLifecycle();
    const second = createIngressLifecycle();

    await handler(createTextMessageData("m-gated-1") as never, {} as never, {
      turnAdoptionLifecycle: first,
    });
    await handler(createTextMessageData("m-gated-2") as never, {} as never, {
      turnAdoptionLifecycle: second,
    });

    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
  });

  it("returns retryable, never completed, for a dispatch after shutdown", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await handler.deactivate();
    const lifecycle = createIngressLifecycle();

    // Completing here would tombstone a message that never dispatched; the
    // claim must release so a restarted drain replays it.
    const result = await handler(createTextMessageData("m-after-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });

    expect(result).toMatchObject({ kind: "failed-retryable" });
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("abandons a buffered ingress claim during deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 60_000 } };
    const handler = createDiscordMessageHandler(params);
    const lifecycle = createIngressLifecycle();

    await handler(createTextMessageData("m-cancel") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await handler.deactivate();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("waits for an active debounce flush and abandons it after shutdown", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const preflightGate = createDeferred();
    preflightDiscordMessageMock.mockImplementation(async () => {
      await preflightGate.promise;
      return null;
    });
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    const lifecycle = createIngressLifecycle();
    const handling = handler(createTextMessageData("m-active-stop") as never, {} as never, {
      turnAdoptionLifecycle: lifecycle,
    });
    await vi.waitFor(() => expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1));

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(deactivated).toBe(false);

    preflightGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(lifecycle.onAbandoned).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAdopted).not.toHaveBeenCalled();
  });

  it("waits for an active durable admission before stopping the drain", async () => {
    const admissionGate = createDeferred();
    const accept = vi.fn(() => admissionGate.promise);
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const params = createDiscordHandlerParams();
    const handler = createDurableDiscordMessageHandler({
      ...params,
      client: {} as never,
      testing: {
        createIngressMonitor: vi.fn(() => ({ accept, start, stop })),
      },
    });
    const handling = handler({ id: "m-admitting", channel_id: "ch-1" } as never, {} as never);

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(deactivated).toBe(false);

    admissionGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not abort long queued runs with a Discord-owned channel timeout", async () => {
    vi.useFakeTimers();
    try {
      preflightDiscordMessageMock.mockReset();
      processDiscordMessageMock.mockReset();

      const firstRun = createDeferred();
      const secondRun = createDeferred();
      const capturedAbortSignals: Array<AbortSignal | undefined> = [];
      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          capturedAbortSignals.push(ctx.abortSignal);
          await firstRun.promise;
        },
      );
      processDiscordMessageMock.mockImplementationOnce(
        async (ctx: { abortSignal?: AbortSignal }) => {
          capturedAbortSignals.push(ctx.abortSignal);
          await secondRun.promise;
        },
      );
      installDefaultDiscordPreflight();
      const params = createDiscordHandlerParams();
      const handler = createDiscordMessageHandler(params);

      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();
      await expect(
        handler(createMessageData("m-2") as never, {} as never),
      ).resolves.toBeUndefined();
      await flushQueueWork();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushQueueWork();

      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
      expect(capturedAbortSignals).toEqual([undefined]);
      const runtimeError = params.runtime.error as unknown as MockCallSource;
      expect(
        mockCalls(runtimeError).some(([message]) => String(message).includes("timed out")),
      ).toBe(false);

      firstRun.resolve();
      await firstRun.promise;
      await flushQueueWork();

      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(capturedAbortSignals).toEqual([undefined, undefined]);

      secondRun.resolve();
      await secondRun.promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes run activity while active runs are in progress", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const runInFlight = createDeferred();
    processDiscordMessageMock.mockImplementation(async () => {
      await runInFlight.promise;
    });
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    let heartbeatTick: () => void = () => {};
    let capturedHeartbeat = false;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          heartbeatTick = () => {
            callback();
          };
          capturedHeartbeat = true;
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      const setStatus = vi.fn();
      const handler = createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));
      await expect(
        handler(createMessageData("m-1") as never, {} as never),
      ).resolves.toBeUndefined();

      await flushQueueWork();
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

      expect(capturedHeartbeat).toBe(true);
      const busyCallsBefore = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;

      heartbeatTick();

      const busyCallsAfter = setStatus.mock.calls.filter(
        ([patch]) => (patch as { busy?: boolean }).busy === true,
      ).length;
      expect(busyCallsAfter).toBeGreaterThan(busyCallsBefore);

      runInFlight.resolve();
      await runInFlight.promise;

      await flushQueueWork();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("stops status publishing after lifecycle abort", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const abortController = new AbortController();
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status, abortSignal: abortController.signal }),
        );
        return { handler, stop: () => abortController.abort() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("stops status publishing after handler deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const { setStatus, callsBeforeStop, finish } = await createLifecycleStopScenario({
      createHandler: (status) => {
        const handler = createDiscordMessageHandler(
          createDiscordHandlerParams({ setStatus: status }),
        );
        return { handler, stop: () => handler.deactivate() };
      },
    });

    await finish();
    expect(setStatus.mock.calls.length).toBe(callsBeforeStop);
  });

  it("removes lifecycle abort listeners after handler deactivation", async () => {
    const abortController = new AbortController();
    const initialListenerCount = getEventListeners(abortController.signal, "abort").length;
    const handler = createDiscordMessageHandler(
      createDiscordHandlerParams({ abortSignal: abortController.signal }),
    );

    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(
      initialListenerCount + 2,
    );

    await handler.deactivate();

    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(initialListenerCount);
  });

  it("skips queued runs that have not started yet after deactivation", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);

    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();
    const deactivation = handler.deactivate();

    firstRun.resolve();
    await firstRun.promise;
    await deactivation;
    await Promise.resolve();

    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("preserves non-debounced message ordering by awaiting debouncer enqueue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstPreflight = createDeferred();
    const processedMessageIds: string[] = [];

    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string; message?: { id?: string } } }) => {
        const messageId = params.data.message?.id ?? "unknown";
        if (messageId === "m-1") {
          await firstPreflight.promise;
        }
        return {
          ...createPreflightContext(params.data.channel_id),
          messageId,
        };
      },
    );

    processDiscordMessageMock.mockImplementation(async (ctx: { messageId?: string }) => {
      processedMessageIds.push(ctx.messageId ?? "unknown");
    });

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    const sequentialDispatch = (async () => {
      await handler(createMessageData("m-1") as never, {} as never);
      await handler(createMessageData("m-2") as never, {} as never);
    })();

    await flushQueueWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);

    firstPreflight.resolve();
    await sequentialDispatch;

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(processedMessageIds).toEqual(["m-1", "m-2"]);
  });

  it("recovers queue progress after a run failure without leaving busy state stuck", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const firstRun = createDeferred();
    processDiscordMessageMock
      .mockImplementationOnce(async () => {
        await firstRun.promise;
        throw new Error("simulated run failure");
      })
      .mockImplementationOnce(async () => undefined);
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const setStatus = vi.fn();
    const handler = createHandlerWithDefaultPreflight({ setStatus });

    await expect(handler(createMessageData("m-1") as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(createMessageData("m-2") as never, {} as never)).resolves.toBeUndefined();

    firstRun.resolve();
    await firstRun.promise.catch(() => undefined);

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expectStatusPatch(setStatus, { activeRuns: 0, busy: false });
  });
});
