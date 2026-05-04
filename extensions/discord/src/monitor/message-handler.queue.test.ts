import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordRetryableInboundError } from "./inbound-dedupe.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

const earlyTypingMocks = vi.hoisted(() => ({
  createDiscordRestClient: vi.fn(() => ({
    token: "test-token",
    rest: { kind: "discord-rest" },
    account: { accountId: "default", config: {} },
  })),
  sendTyping: vi.fn(async () => {}),
}));

vi.mock("../client.js", () => ({
  createDiscordRestClient: earlyTypingMocks.createDiscordRestClient,
}));

vi.mock("./typing.js", () => ({
  sendTyping: earlyTypingMocks.sendTyping,
}));

type SetStatusFn = (patch: Record<string, unknown>) => void;
function createDeferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
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
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
  };
}

function createAcceptedDmPreflightContext(overrides: Record<string, unknown> = {}) {
  return {
    ...createPreflightContext("dm-1"),
    isDirectMessage: true,
    isGuildMessage: false,
    isGroupDm: false,
    messageText: "hello",
    ...overrides,
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
    handler: (data: never, opts: never) => Promise<void>;
    stop: () => void;
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
  stop();

  return {
    setStatus,
    callsBeforeStop,
    finish: async () => {
      runInFlight.resolve();
      await runInFlight.promise;
      await Promise.resolve();
    },
  };
}

describe("createDiscordMessageHandler queue behavior", () => {
  beforeEach(() => {
    earlyTypingMocks.createDiscordRestClient.mockReset().mockReturnValue({
      token: "test-token",
      rest: { kind: "discord-rest" },
      account: { accountId: "default", config: {} },
    });
    earlyTypingMocks.sendTyping.mockReset().mockResolvedValue(undefined);
  });

  it("sends an accepted DM typing cue before queued processing starts", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(createAcceptedDmPreflightContext());
    processDiscordMessageMock.mockResolvedValue(undefined);

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(
      handler(createMessageData("m-typing", "dm-1") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushQueueWork();

    expect(earlyTypingMocks.createDiscordRestClient).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        token: "test-token",
      }),
    );
    expect(earlyTypingMocks.sendTyping).toHaveBeenCalledWith({
      rest: { kind: "discord-rest" },
      channelId: "dm-1",
    });
    expect(earlyTypingMocks.sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      processDiscordMessageMock.mock.invocationCallOrder[0],
    );
  });

  it("keeps accepted DM dispatch running when the early typing cue fails", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    earlyTypingMocks.sendTyping.mockRejectedValueOnce(new Error("typing failed"));
    preflightDiscordMessageMock.mockResolvedValue(createAcceptedDmPreflightContext());
    processDiscordMessageMock.mockResolvedValue(undefined);

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(
      handler(createMessageData("m-typing-fails", "dm-1") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushQueueWork();

    expect(earlyTypingMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not send early typing when preflight rejects the message", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(null);

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(
      handler(createMessageData("m-rejected", "dm-1") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushQueueWork();

    expect(earlyTypingMocks.sendTyping).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("does not send early typing when typing mode is not instant", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(
      createAcceptedDmPreflightContext({
        cfg: {
          ...createPreflightContext().cfg,
          agents: {
            defaults: {
              typingMode: "message",
            },
          },
        },
      }),
    );
    processDiscordMessageMock.mockResolvedValue(undefined);

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(
      handler(createMessageData("m-message-mode", "dm-1") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushQueueWork();

    expect(earlyTypingMocks.sendTyping).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not send early typing for guild messages", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockResolvedValue(
      createAcceptedDmPreflightContext({
        isDirectMessage: false,
        isGuildMessage: true,
        messageChannelId: "guild-channel",
      }),
    );
    processDiscordMessageMock.mockResolvedValue(undefined);

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());
    await expect(
      handler(createMessageData("m-guild", "guild-channel") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushQueueWork();

    expect(earlyTypingMocks.sendTyping).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("resets busy counters when the handler is created", () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const setStatus = vi.fn();
    createDiscordMessageHandler(createDiscordHandlerParams({ setStatus }));

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: 0,
        busy: false,
      }),
    );
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
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: 1,
        busy: true,
      }),
    );

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
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRuns: 0,
        busy: false,
      }),
    );
  });

  it("drops duplicate inbound message deliveries before they reach preflight", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const handler = createHandlerWithDefaultPreflight();
    const duplicate = createMessageData("m-dup");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();

    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("retries duplicate deliveries after an explicit retryable worker failure", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    processDiscordMessageMock
      .mockRejectedValueOnce(new DiscordRetryableInboundError("retry me"))
      .mockResolvedValueOnce(undefined);
    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    installDefaultDiscordPreflight();
    const duplicate = createMessageData("m-retry");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(params.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("discord message run failed: DiscordRetryableInboundError: retry me"),
    );

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(2);
  });

  it("keeps replay committed after a non-retryable worker failure", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const visibleSideEffect = vi.fn();
    processDiscordMessageMock.mockImplementationOnce(async () => {
      visibleSideEffect();
      throw new Error("post-send failure");
    });
    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler(params);
    installDefaultDiscordPreflight();
    const duplicate = createMessageData("m-fail");

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await flushQueueWork();
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(params.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("discord message run failed: Error: post-send failure"),
    );

    await expect(handler(duplicate as never, {} as never)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(visibleSideEffect).toHaveBeenCalledTimes(1);
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
      expect(capturedAbortSignals[0]?.aborted).not.toBe(true);
      expect(params.runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("timed out"));

      firstRun.resolve();
      await firstRun.promise;
      await flushQueueWork();

      expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
      expect(capturedAbortSignals[1]?.aborted).not.toBe(true);

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
    handler.deactivate();

    firstRun.resolve();
    await firstRun.promise;
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
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ activeRuns: 0, busy: false }));
  });
});
