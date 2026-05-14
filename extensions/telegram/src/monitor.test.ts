import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MonitorTelegramOpts = import("./monitor.js").MonitorTelegramOpts;
let monitorTelegramProvider: typeof import("./monitor.js").monitorTelegramProvider;
let resetTelegramPollingLeasesForTests: typeof import("./polling-lease.js").resetTelegramPollingLeasesForTests;

type MockCtx = {
  message: {
    message_id?: number;
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
  };
  me?: { username: string };
  getFile: () => Promise<unknown>;
};

// Fake bot to capture handler and API calls
const handlers: Record<string, (ctx: MockCtx) => Promise<void> | void> = {};
const api = {
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
  sendAudio: vi.fn(),
  sendDocument: vi.fn(),
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getWebhookInfo: vi.fn(async () => ({ url: "" })),
  getUpdates: vi.fn(async () => []),
  config: {
    use: vi.fn(),
  },
};
const { initSpy, runSpy, getRuntimeConfigMock } = vi.hoisted(() => ({
  initSpy: vi.fn(async () => undefined),
  runSpy: vi.fn(() => ({
    task: () => Promise.resolve(),
    stop: vi.fn(),
    isRunning: (): boolean => false,
  })),
  getRuntimeConfigMock: vi.fn(() => ({
    agents: { defaults: { maxConcurrent: 2 } },
    channels: { telegram: {} },
  })),
}));

const {
  registerUnhandledRejectionHandlerMock,
  registerUncaughtExceptionHandlerMock,
  emitUnhandledRejection,
  emitUncaughtException,
  resetProcessErrorHandlers,
} = vi.hoisted(() => {
  let unhandledRejectionHandler: ((reason: unknown) => boolean) | undefined;
  let uncaughtExceptionHandler: ((error: unknown) => boolean) | undefined;
  return {
    registerUnhandledRejectionHandlerMock: vi.fn((next: (reason: unknown) => boolean) => {
      unhandledRejectionHandler = next;
      return () => {
        if (unhandledRejectionHandler === next) {
          unhandledRejectionHandler = undefined;
        }
      };
    }),
    registerUncaughtExceptionHandlerMock: vi.fn((next: (error: unknown) => boolean) => {
      uncaughtExceptionHandler = next;
      return () => {
        if (uncaughtExceptionHandler === next) {
          uncaughtExceptionHandler = undefined;
        }
      };
    }),
    emitUnhandledRejection: (reason: unknown) => unhandledRejectionHandler?.(reason) ?? false,
    emitUncaughtException: (error: unknown) => uncaughtExceptionHandler?.(error) ?? false,
    resetProcessErrorHandlers: () => {
      unhandledRejectionHandler = undefined;
      uncaughtExceptionHandler = undefined;
    },
  };
});

const { createTelegramBotErrors } = vi.hoisted(() => ({
  createTelegramBotErrors: [] as unknown[],
}));

const { createTelegramBotCalls } = vi.hoisted(() => ({
  createTelegramBotCalls: [] as Array<Record<string, unknown>>,
}));

const { createdBotStops } = vi.hoisted(() => ({
  createdBotStops: [] as Array<ReturnType<typeof vi.fn<() => void>>>,
}));

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));
const { readTelegramUpdateOffsetSpy } = vi.hoisted(() => ({
  readTelegramUpdateOffsetSpy: vi.fn(async () => null as number | null),
}));
const { startTelegramWebhookSpy } = vi.hoisted(() => ({
  startTelegramWebhookSpy: vi.fn(async () => ({ server: { close: vi.fn() }, stop: vi.fn() })),
}));
const { resolveTelegramTransportSpy } = vi.hoisted(() => ({
  resolveTelegramTransportSpy: vi.fn(() => ({
    fetch: globalThis.fetch,
    sourceFetch: globalThis.fetch,
    close: vi.fn(async () => undefined),
  })),
}));

type RunnerStub = {
  task: () => Promise<void>;
  stop: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
  isRunning: () => boolean;
};

const withLegacyPolling = (opts: MonitorTelegramOpts): MonitorTelegramOpts => ({
  ...opts,
  isolatedIngress: { enabled: false, ...opts.isolatedIngress },
});

const makeRunnerStub = (overrides: Partial<RunnerStub> = {}): RunnerStub => ({
  task: overrides.task ?? (() => Promise.resolve()),
  stop: overrides.stop ?? vi.fn<() => void | Promise<void>>(),
  isRunning: overrides.isRunning ?? (() => false),
});

function makeRecoverableFetchError() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect timeout"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
}

class MockHttpError extends Error {
  constructor(
    message: string,
    public readonly error: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function makeTaggedPollingFetchError() {
  const { tagTelegramNetworkError } = await import("./network-errors.js");
  const err = makeRecoverableFetchError();
  tagTelegramNetworkError(err, {
    method: "getUpdates",
    url: "https://api.telegram.org/bot123456:ABC/getUpdates",
  });
  return err;
}

async function makeTaggedPollingHttpError() {
  return new MockHttpError(
    "Network request for 'getUpdates' failed!",
    await makeTaggedPollingFetchError(),
  );
}

const createAbortTask = (
  abort: AbortController,
  beforeAbort?: () => void,
): (() => Promise<void>) => {
  return async () => {
    beforeAbort?.();
    abort.abort();
  };
};

const makeAbortRunner = (abort: AbortController, beforeAbort?: () => void): RunnerStub =>
  makeRunnerStub({ task: createAbortTask(abort, beforeAbort) });

function createSignal() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected Telegram monitor signal resolver to be initialized");
  }
  return { promise, resolve };
}

function mockRunOnceAndAbort(abort: AbortController) {
  const started = createSignal();
  runSpy.mockImplementationOnce(() => {
    started.resolve();
    return makeAbortRunner(abort);
  });
  return { waitForRunStart: () => started.promise };
}

async function expectOffsetConfirmationSkipped(offset: number | null) {
  readTelegramUpdateOffsetSpy.mockResolvedValueOnce(offset);
  const abort = new AbortController();
  api.getUpdates.mockReset();
  api.deleteWebhook.mockReset();
  api.deleteWebhook.mockResolvedValueOnce(true);
  mockRunOnceAndAbort(abort);

  await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

  expect(api.getUpdates).not.toHaveBeenCalled();
}

async function runMonitorAndCaptureStartupOrder(params?: { persistedOffset?: number | null }) {
  if (params && "persistedOffset" in params) {
    readTelegramUpdateOffsetSpy.mockResolvedValueOnce(params.persistedOffset ?? null);
  }
  const abort = new AbortController();
  const order: string[] = [];
  api.getUpdates.mockReset();
  api.deleteWebhook.mockReset();
  api.deleteWebhook.mockImplementationOnce(async () => {
    order.push("deleteWebhook");
    return true;
  });
  if (typeof params?.persistedOffset === "number") {
    api.getUpdates.mockImplementationOnce(async () => {
      order.push("getUpdates");
      return [];
    });
  }
  runSpy.mockImplementationOnce(() => {
    order.push("run");
    return makeAbortRunner(abort);
  });

  await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));
  return { order };
}

function mockRunOnceWithStalledPollingRunner(): {
  stop: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
  waitForRunStart: () => Promise<void>;
  waitForTaskStart: () => Promise<void>;
} {
  let running = true;
  let releaseTask: (() => void) | undefined;
  let releaseBeforeTaskStart = false;
  let signalRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    signalRunStarted = resolve;
  });
  let signalTaskStarted: (() => void) | undefined;
  const taskStarted = new Promise<void>((resolve) => {
    signalTaskStarted = resolve;
  });
  const stop = vi.fn(async () => {
    running = false;
    if (releaseTask) {
      releaseTask();
      return;
    }
    releaseBeforeTaskStart = true;
  });
  runSpy.mockImplementationOnce(() => {
    signalRunStarted?.();
    return makeRunnerStub({
      task: () =>
        new Promise<void>((resolve) => {
          signalTaskStarted?.();
          releaseTask = resolve;
          if (releaseBeforeTaskStart) {
            resolve();
          }
        }),
      stop,
      isRunning: () => running,
    });
  });
  return {
    stop,
    waitForRunStart: () => runStarted,
    waitForTaskStart: () => taskStarted,
  };
}

function expectRecoverableRetryState(
  expectedRunCalls: number,
  options?: { assertBackoffHelpers?: boolean },
) {
  // monitorTelegramProvider now delegates retry pacing to TelegramPollingSession +
  // grammY runner retry settings, so these plugin-sdk helpers are not exercised
  // on the outer loop anymore. Keep asserting exact cycle count to guard
  // against busy-loop regressions in recoverable paths.
  if (options?.assertBackoffHelpers) {
    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
  }
  expect(runSpy).toHaveBeenCalledTimes(expectedRunCalls);
}

function latestMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function monitorWithAutoAbort(opts: Omit<MonitorTelegramOpts, "abortSignal"> = {}) {
  const abort = new AbortController();
  mockRunOnceAndAbort(abort);
  await monitorTelegramProvider({
    token: "tok",
    ...opts,
    abortSignal: abort.signal,
    isolatedIngress: { enabled: false, ...opts.isolatedIngress },
  });
}

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  return {
    getRuntimeConfig: getRuntimeConfigMock,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (opts: Record<string, unknown>) => {
    createTelegramBotCalls.push(opts);
    const nextError = createTelegramBotErrors.shift();
    if (nextError) {
      throw nextError;
    }
    const stop = vi.fn<() => void>();
    createdBotStops.push(stop);
    handlers.message = async (ctx: MockCtx) => {
      const chatId = ctx.message.chat.id;
      const isGroup = ctx.message.chat.type !== "private";
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (isGroup && !text.includes("@mybot")) {
        return;
      }
      if (!text.trim()) {
        return;
      }
      await api.sendMessage(chatId, `echo:${text}`, { parse_mode: "HTML" });
    };
    return {
      on: vi.fn(),
      api,
      me: { username: "mybot" },
      init: initSpy,
      stop,
      start: vi.fn(),
    };
  },
}));

// Mock the grammyjs/runner to resolve immediately
vi.mock("@grammyjs/runner", () => ({
  run: runSpy,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    computeBackoff,
    sleepWithAbort,
    registerUnhandledRejectionHandler: registerUnhandledRejectionHandlerMock,
    registerUncaughtExceptionHandler: registerUncaughtExceptionHandlerMock,
  };
});

vi.mock("./webhook.js", () => ({
  startTelegramWebhook: startTelegramWebhookSpy,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: resolveTelegramTransportSpy,
}));

vi.mock("./update-offset-store.js", () => ({
  readTelegramUpdateOffset: readTelegramUpdateOffsetSpy,
  writeTelegramUpdateOffset: vi.fn(async () => undefined),
  deleteTelegramUpdateOffset: vi.fn(async () => undefined),
}));

describe("monitorTelegramProvider (grammY)", () => {
  let consoleErrorSpy: { mockRestore: () => void } | undefined;

  beforeAll(async () => {
    ({ monitorTelegramProvider } = await import("./monitor.js"));
    ({ resetTelegramPollingLeasesForTests } = await import("./polling-lease.js"));
  });

  beforeEach(() => {
    resetTelegramPollingLeasesForTests();
    getRuntimeConfigMock.mockReturnValue({
      agents: { defaults: { maxConcurrent: 2 } },
      channels: { telegram: {} },
    });
    initSpy.mockClear();
    readTelegramUpdateOffsetSpy.mockReset().mockResolvedValue(null);
    api.getUpdates.mockReset().mockResolvedValue([]);
    runSpy.mockReset().mockImplementation(() =>
      makeRunnerStub({
        task: () => Promise.reject(new Error("runSpy called without explicit test stub")),
      }),
    );
    createTelegramBotCalls.length = 0;
    computeBackoff.mockClear();
    sleepWithAbort.mockClear();
    startTelegramWebhookSpy.mockClear();
    resolveTelegramTransportSpy.mockReset().mockImplementation(() => ({
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    }));
    registerUnhandledRejectionHandlerMock.mockClear();
    registerUncaughtExceptionHandlerMock.mockClear();
    resetProcessErrorHandlers();
    createTelegramBotErrors.length = 0;
    createdBotStops.length = 0;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
  });

  it("processes a DM and sends reply", async () => {
    for (const v of Object.values(api)) {
      if (typeof v === "function" && "mockReset" in v) {
        (v as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    await monitorWithAutoAbort();
    if (!handlers.message) {
      throw new Error("expected Telegram message handler");
    }
    await handlers.message({
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        text: "hi",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).toHaveBeenCalledWith(123, "echo:hi", {
      parse_mode: "HTML",
    });
  });

  it("uses agent maxConcurrent for runner concurrency", async () => {
    runSpy.mockClear();
    getRuntimeConfigMock.mockReturnValue({
      agents: { defaults: { maxConcurrent: 3 } },
      channels: { telegram: {} },
    });

    await monitorWithAutoAbort();

    type RunOptions = {
      sink?: { concurrency?: number };
      runner?: { silent?: boolean; maxRetryTime?: number; retryInterval?: string };
    };
    const runCall = latestMockCall(runSpy, "run") as [unknown, RunOptions];
    const runOptions = runCall[1];
    expect(runOptions?.sink?.concurrency).toBe(3);
    expect(runOptions?.runner?.silent).toBe(true);
    expect(runOptions?.runner?.maxRetryTime).toBe(60 * 60 * 1000);
    expect(runOptions?.runner?.retryInterval).toBe("exponential");
  });

  it("requires mention in groups by default", async () => {
    for (const v of Object.values(api)) {
      if (typeof v === "function" && "mockReset" in v) {
        (v as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    await monitorWithAutoAbort();
    await handlers.message?.({
      message: {
        message_id: 2,
        chat: { id: -99, type: "supergroup", title: "G" },
        text: "hello all",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("retries on recoverable undici fetch errors", async () => {
    const abort = new AbortController();
    const networkError = makeRecoverableFetchError();
    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () => Promise.reject(networkError),
        }),
      )
      .mockImplementationOnce(() => makeAbortRunner(abort));

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    expectRecoverableRetryState(2);
  });

  it("deletes webhook before starting polling", async () => {
    const { order } = await runMonitorAndCaptureStartupOrder();

    expect(api.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: false });
    expect(order).toEqual(["deleteWebhook", "run"]);
  });

  it("starts polling after recoverable deleteWebhook failures", async () => {
    const abort = new AbortController();
    const cleanupError = makeRecoverableFetchError();
    api.deleteWebhook.mockReset();
    api.getWebhookInfo.mockReset();
    api.deleteWebhook.mockRejectedValueOnce(cleanupError);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    expect(api.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(api.getWebhookInfo).not.toHaveBeenCalled();
    expectRecoverableRetryState(1);
  });

  it("does not run webhook confirmation when deleteWebhook transiently fails", async () => {
    const abort = new AbortController();
    const cleanupError = makeRecoverableFetchError();
    api.deleteWebhook.mockReset();
    api.getWebhookInfo.mockReset();
    api.deleteWebhook.mockRejectedValueOnce(cleanupError);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    expect(api.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(api.getWebhookInfo).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).not.toHaveBeenCalled();
  });

  it("retries setup-time recoverable errors before starting polling", async () => {
    const abort = new AbortController();
    const setupError = makeRecoverableFetchError();
    createTelegramBotErrors.push(setupError);
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    expectRecoverableRetryState(1);
  });

  it("awaits runner.stop before retrying after recoverable polling error", async () => {
    const abort = new AbortController();
    const recoverableError = makeRecoverableFetchError();
    let firstStopped = false;
    const firstStop = vi.fn(async () => {
      await Promise.resolve();
      firstStopped = true;
    });

    runSpy
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () => Promise.reject(recoverableError),
          stop: firstStop,
        }),
      )
      .mockImplementationOnce(() => {
        expect(firstStopped).toBe(true);
        return makeAbortRunner(abort);
      });

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    expect(firstStop).toHaveBeenCalled();
    expectRecoverableRetryState(2);
  });

  it("stops bot instance when polling cycle exits", async () => {
    const abort = new AbortController();
    mockRunOnceAndAbort(abort);

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    expect(createdBotStops.length).toBe(1);
    expect(createdBotStops[0]).toHaveBeenCalledTimes(1);
  });

  it("refuses a concurrent same-token polling monitor before starting another runner", async () => {
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    await expect(monitorTelegramProvider(withLegacyPolling({ token: "tok" }))).rejects.toThrow(
      "refusing duplicate poller",
    );
    expect(runSpy).toHaveBeenCalledTimes(1);

    abort.abort();
    await monitor;
  });

  it("allows concurrent polling monitors for different bot tokens", async () => {
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const secondCycle = mockRunOnceWithStalledPollingRunner();

    const firstMonitor = monitorTelegramProvider(
      withLegacyPolling({
        token: "tok-a",
        abortSignal: firstAbort.signal,
      }),
    );
    await firstCycle.waitForRunStart();
    const secondMonitor = monitorTelegramProvider(
      withLegacyPolling({
        token: "tok-b",
        abortSignal: secondAbort.signal,
      }),
    );
    await secondCycle.waitForRunStart();

    expect(runSpy).toHaveBeenCalledTimes(2);

    firstAbort.abort();
    secondAbort.abort();
    await Promise.all([firstMonitor, secondMonitor]);
  });

  it("starts a same-token replacement after the previous monitor releases", async () => {
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();

    const firstMonitor = monitorTelegramProvider(
      withLegacyPolling({
        token: "tok",
        abortSignal: firstAbort.signal,
      }),
    );
    await firstCycle.waitForRunStart();
    firstAbort.abort();

    const secondCycle = mockRunOnceAndAbort(secondAbort);
    const secondMonitor = monitorTelegramProvider(
      withLegacyPolling({
        token: "tok",
        abortSignal: secondAbort.signal,
      }),
    );
    await secondCycle.waitForRunStart();
    await Promise.all([firstMonitor, secondMonitor]);

    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("clears bounded cleanup timers after a clean stop", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      mockRunOnceAndAbort(abort);

      await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces non-recoverable errors", async () => {
    runSpy.mockImplementationOnce(() =>
      makeRunnerStub({
        task: () => Promise.reject(new Error("bad token")),
      }),
    );

    await expect(monitorTelegramProvider(withLegacyPolling({ token: "tok" }))).rejects.toThrow(
      "bad token",
    );
  });

  it("force-restarts polling when unhandled network rejection stalls runner", async () => {
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const secondCycle = mockRunOnceWithStalledPollingRunner();

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    expect(emitUnhandledRejection(await makeTaggedPollingFetchError())).toBe(true);
    expect(firstCycle.stop).toHaveBeenCalledTimes(1);
    // Unhandled polling rejections restart via TelegramPollingSession backoff,
    // so the second runner cycle is not immediate.
    await secondCycle.waitForRunStart();
    abort.abort();
    await monitor;
    expectRecoverableRetryState(2);
  });

  it("force-restarts polling when uncaught network exception stalls runner", async () => {
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const secondCycle = mockRunOnceWithStalledPollingRunner();

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    expect(emitUncaughtException(await makeTaggedPollingFetchError())).toBe(true);
    expect(firstCycle.stop).toHaveBeenCalledTimes(1);
    await secondCycle.waitForRunStart();
    abort.abort();
    await monitor;
    expectRecoverableRetryState(2);
  });

  it("force-restarts polling when uncaught polling HttpError stalls runner", async () => {
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const secondCycle = mockRunOnceWithStalledPollingRunner();

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    expect(emitUncaughtException(await makeTaggedPollingHttpError())).toBe(true);
    expect(firstCycle.stop).toHaveBeenCalledTimes(1);
    await secondCycle.waitForRunStart();
    abort.abort();
    await monitor;
    expectRecoverableRetryState(2);
  });

  it("rebuilds the resolved transport after a stalled polling restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const telegramTransport = {
        fetch: globalThis.fetch,
        sourceFetch: globalThis.fetch,
        close: vi.fn(async () => undefined),
      };
      const rebuiltTransport = {
        fetch: globalThis.fetch,
        sourceFetch: globalThis.fetch,
        close: vi.fn(async () => undefined),
      };
      resolveTelegramTransportSpy
        .mockReturnValueOnce(telegramTransport)
        .mockReturnValueOnce(rebuiltTransport);

      const abort = new AbortController();
      const firstCycle = mockRunOnceWithStalledPollingRunner();
      const secondCycle = mockRunOnceAndAbort(abort);

      const monitor = monitorTelegramProvider(
        withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
      );
      await firstCycle.waitForRunStart();

      vi.advanceTimersByTime(150_000);
      await secondCycle.waitForRunStart();
      await monitor;

      expect(resolveTelegramTransportSpy).toHaveBeenCalledTimes(2);
      expect(createTelegramBotCalls).toHaveLength(2);
      expect(createTelegramBotCalls[0]?.telegramTransport).toBe(telegramTransport);
      expect(createTelegramBotCalls[1]?.telegramTransport).toBe(rebuiltTransport);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds the resolved transport after an unhandled polling network rejection", async () => {
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const telegramTransport = {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    };
    const rebuiltTransport = {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    };
    resolveTelegramTransportSpy
      .mockReturnValueOnce(telegramTransport)
      .mockReturnValueOnce(rebuiltTransport);
    const secondCycle = mockRunOnceAndAbort(abort);

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    expect(emitUnhandledRejection(await makeTaggedPollingFetchError())).toBe(true);
    expect(firstCycle.stop).toHaveBeenCalledTimes(1);
    await secondCycle.waitForRunStart();
    await monitor;

    expect(resolveTelegramTransportSpy).toHaveBeenCalledTimes(2);
    expect(createTelegramBotCalls).toHaveLength(2);
    expect(createTelegramBotCalls[0]?.telegramTransport).toBe(telegramTransport);
    expect(createTelegramBotCalls[1]?.telegramTransport).toBe(rebuiltTransport);
  });

  it("aborts the active Telegram fetch when unhandled network rejection forces restart", async () => {
    const abort = new AbortController();
    const { stop, waitForTaskStart } = mockRunOnceWithStalledPollingRunner();
    const secondCycle = mockRunOnceAndAbort(abort);

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await waitForTaskStart();
    const firstSignal = createTelegramBotCalls[0]?.fetchAbortSignal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect((firstSignal as AbortSignal).aborted).toBe(false);

    emitUnhandledRejection(await makeTaggedPollingFetchError());
    await secondCycle.waitForRunStart();
    await monitor;

    expect((firstSignal as AbortSignal).aborted).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  it("ignores unrelated process-level network errors while telegram polling is active", async () => {
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const { stop } = firstCycle;

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    const slackDnsError = Object.assign(
      new Error("A request error occurred: getaddrinfo ENOTFOUND slack.com"),
      {
        code: "ENOTFOUND",
        hostname: "slack.com",
      },
    );
    expect(emitUnhandledRejection(slackDnsError)).toBe(false);

    abort.abort();
    await monitor;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(computeBackoff).not.toHaveBeenCalled();
    expect(sleepWithAbort).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("passes configured webhookHost to webhook listener", async () => {
    const setStatus = vi.fn();
    await monitorTelegramProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.test/telegram",
      webhookSecret: "secret",
      setStatus,
      config: {
        agents: { defaults: { maxConcurrent: 2 } },
        channels: {
          telegram: {
            webhookHost: "0.0.0.0",
          },
        },
      },
    });

    const webhookCall = latestMockCall(startTelegramWebhookSpy, "startTelegramWebhook") as [
      { host?: string; setStatus?: unknown },
    ];
    const webhookOptions = webhookCall[0];
    expect(webhookOptions?.host).toBe("0.0.0.0");
    expect(webhookOptions?.setStatus).toBe(setStatus);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("webhook mode waits for abort signal before returning", async () => {
    const abort = new AbortController();
    const settled = vi.fn();
    const monitor = monitorTelegramProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.test/telegram",
      webhookSecret: "secret",
      abortSignal: abort.signal,
    }).then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    abort.abort();
    await monitor;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("force-restarts polling when getUpdates stalls (watchdog)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const { stop } = firstCycle;
    const secondCycle = mockRunOnceAndAbort(abort);

    const monitor = monitorTelegramProvider(
      withLegacyPolling({ token: "tok", abortSignal: abort.signal }),
    );
    await firstCycle.waitForRunStart();

    // Advance time past the stall threshold (120s) + watchdog interval (30s)
    vi.advanceTimersByTime(150_000);
    await secondCycle.waitForRunStart();
    await monitor;

    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(1);
    expectRecoverableRetryState(2);
    vi.useRealTimers();
  });

  it("uses configured Telegram polling stall threshold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const firstCycle = mockRunOnceWithStalledPollingRunner();
    const secondCycle = mockRunOnceAndAbort(abort);

    const monitor = monitorTelegramProvider(
      withLegacyPolling({
        token: "tok",
        abortSignal: abort.signal,
        config: {
          agents: { defaults: { maxConcurrent: 2 } },
          channels: { telegram: { pollingStallThresholdMs: 30_000 } },
        },
      }),
    );
    await firstCycle.waitForRunStart();

    vi.advanceTimersByTime(60_000);
    await secondCycle.waitForRunStart();
    await monitor;

    expect(firstCycle.stop.mock.calls.length).toBeGreaterThanOrEqual(1);
    expectRecoverableRetryState(2);
    vi.useRealTimers();
  });

  it("does not call getUpdates for offset confirmation (avoids 409 conflicts)", async () => {
    const { order } = await runMonitorAndCaptureStartupOrder({
      persistedOffset: 549076203,
    });

    // OpenClaw middleware skips duplicates using the persisted update offset.
    expect(api.getUpdates).not.toHaveBeenCalled();
    expect(order).toEqual(["deleteWebhook", "run"]);
  });

  it("skips offset confirmation when no persisted offset exists", async () => {
    await expectOffsetConfirmationSkipped(null);
  });

  it("skips offset confirmation when persisted offset is invalid", async () => {
    await expectOffsetConfirmationSkipped(-1);
  });

  it("skips offset confirmation when persisted offset cannot be safely incremented", async () => {
    await expectOffsetConfirmationSkipped(Number.MAX_SAFE_INTEGER);
  });

  it("resets webhookCleared latch on 409 conflict so deleteWebhook re-runs, and rebuilds transport for a fresh TCP socket (#69787)", async () => {
    const abort = new AbortController();
    api.deleteWebhook.mockReset();
    api.deleteWebhook.mockResolvedValue(true);
    const telegramTransport1 = {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    };
    const telegramTransport2 = {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    };
    // First call is the initial cycle; second call is the post-409 rebuild
    // that forces a fresh TCP connection (see #69787 polling-session fix).
    resolveTelegramTransportSpy
      .mockReturnValueOnce(telegramTransport1)
      .mockReturnValueOnce(telegramTransport2);

    const conflictError = Object.assign(
      new Error("Conflict: terminated by other getUpdates request"),
      {
        error_code: 409,
        method: "getUpdates",
      },
    );

    let pollingCycle = 0;
    runSpy
      // First cycle: throw 409 conflict
      .mockImplementationOnce(() =>
        makeRunnerStub({
          task: () => {
            pollingCycle++;
            return Promise.reject(conflictError);
          },
        }),
      )
      // Second cycle: succeed then abort
      .mockImplementationOnce(() => {
        pollingCycle++;
        return makeAbortRunner(abort);
      });

    await monitorTelegramProvider(withLegacyPolling({ token: "tok", abortSignal: abort.signal }));

    // deleteWebhook should be called twice: once on initial cleanup, once after 409 reset
    expect(api.deleteWebhook).toHaveBeenCalledTimes(2);
    expect(pollingCycle).toBe(2);
    expect(runSpy).toHaveBeenCalledTimes(2);
    // Transport is rebuilt on 409 conflict — the second cycle gets a fresh
    // transport so Telegram sees a new TCP socket instead of reusing the
    // keep-alive connection it already terminated.
    expect(resolveTelegramTransportSpy).toHaveBeenCalledTimes(2);
    expect(createTelegramBotCalls[0]?.telegramTransport).toBe(telegramTransport1);
    expect(createTelegramBotCalls[1]?.telegramTransport).toBe(telegramTransport2);
    expect(telegramTransport1.close).toHaveBeenCalledTimes(1);
    expect(telegramTransport2.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to configured webhookSecret when not passed explicitly", async () => {
    await monitorTelegramProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.test/telegram",
      config: {
        agents: { defaults: { maxConcurrent: 2 } },
        channels: {
          telegram: {
            webhookSecret: "secret-from-config",
          },
        },
      },
    });

    const webhookCall = latestMockCall(startTelegramWebhookSpy, "startTelegramWebhook") as [
      { secret?: string },
    ];
    expect(webhookCall[0].secret).toBe("secret-from-config");
    expect(runSpy).not.toHaveBeenCalled();
  });
});
