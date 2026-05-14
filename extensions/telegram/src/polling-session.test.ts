import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const computeBackoffMock = vi.hoisted(() => vi.fn(() => 0));
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@grammyjs/runner", () => ({
  run: runMock,
}));

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
}));

vi.mock("./network-errors.js", () => ({
  isRecoverableTelegramNetworkError: isRecoverableTelegramNetworkErrorMock,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  computeBackoff: computeBackoffMock,
  formatDurationPrecise: vi.fn((ms: number) => `${ms}ms`),
  sleepWithAbort: sleepWithAbortMock,
}));

let TelegramPollingSession: typeof import("./polling-session.js").TelegramPollingSession;
let writeTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.js").writeTelegramSpooledUpdate;

type TelegramApiMiddleware = (
  prev: (...args: unknown[]) => Promise<unknown>,
  method: string,
  payload: unknown,
) => Promise<unknown>;
type AsyncVoidFn = () => Promise<void>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex} to exist`);
  }
  const value = call[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function logContains(source: MockCallSource, text: string): boolean {
  return source.mock.calls.some((call) => String(call[0]).includes(text));
}

function expectLogIncludes(source: MockCallSource, text: string): void {
  expect(logContains(source, text), `Expected log to include ${text}`).toBe(true);
}

function expectLogExcludes(source: MockCallSource, text: string): void {
  expect(logContains(source, text), `Expected log not to include ${text}`).toBe(false);
}

function statusPatches(source: MockCallSource): Record<string, unknown>[] {
  return source.mock.calls.map((call, index) => {
    const patch = call[0];
    if (!patch || typeof patch !== "object") {
      throw new Error(`Expected status patch call ${index} to be an object`);
    }
    return patch as Record<string, unknown>;
  });
}

function expectPollingConnectedPatch(patch: Record<string, unknown> | undefined): void {
  if (!patch) {
    throw new Error("Expected polling connected patch");
  }
  expect(patch.connected).toBe(true);
  expect(patch.mode).toBe("polling");
}

function makeBot() {
  return {
    api: {
      deleteWebhook: vi.fn(async () => true),
      getUpdates: vi.fn(async () => []),
      config: { use: vi.fn() },
    },
    stop: vi.fn(async () => undefined),
  };
}

function installPollingStallWatchdogHarness(dateNowSequence: readonly number[] = [0, 0]) {
  let watchdog: (() => void) | undefined;
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
    watchdog = fn as () => void;
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
    void Promise.resolve().then(() => (fn as () => void)());
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const dateNowSpy = vi.spyOn(Date, "now");
  for (const value of dateNowSequence) {
    dateNowSpy.mockImplementationOnce(() => value);
  }
  dateNowSpy.mockImplementation(() => 0);

  return {
    async waitForWatchdog() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (watchdog) {
          break;
        }
        await Promise.resolve();
      }
      expect(watchdog).toBeTypeOf("function");
      return watchdog;
    },
    setNow(now: number) {
      dateNowSpy.mockReset();
      dateNowSpy.mockImplementation(() => now);
    },
    restore() {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    },
  };
}

function expectTelegramBotTransportSequence(firstTransport: unknown, secondTransport: unknown) {
  expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
  expect(createTelegramBotMock.mock.calls.at(0)?.[0]?.telegramTransport).toBe(firstTransport);
  expect(createTelegramBotMock.mock.calls.at(1)?.[0]?.telegramTransport).toBe(secondTransport);
}

function makeTelegramTransport() {
  return {
    fetch: globalThis.fetch,
    sourceFetch: globalThis.fetch,
    close: vi.fn(async () => undefined),
  };
}

function mockRestartAfterPollingError(error: unknown, abort: AbortController) {
  let firstCycle = true;
  runMock.mockImplementation(() => {
    if (firstCycle) {
      firstCycle = false;
      return {
        task: async () => {
          throw error;
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      };
    }
    return {
      task: async () => {
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    };
  });
}

function createPollingSessionWithTransportRestart(params: {
  abortSignal: AbortSignal;
  telegramTransport: ReturnType<typeof makeTelegramTransport>;
  createTelegramTransport: () => ReturnType<typeof makeTelegramTransport>;
}) {
  return createPollingSession(params);
}

function createPollingSession(params: {
  abortSignal: AbortSignal;
  log?: (message: string) => void;
  telegramTransport?: ReturnType<typeof makeTelegramTransport>;
  createTelegramTransport?: () => ReturnType<typeof makeTelegramTransport>;
  stallThresholdMs?: number;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  isolatedIngress?: ConstructorParameters<typeof TelegramPollingSession>[0]["isolatedIngress"];
}) {
  return new TelegramPollingSession({
    token: "tok",
    config: {},
    accountId: "default",
    runtime: undefined,
    proxyFetch: undefined,
    abortSignal: params.abortSignal,
    runnerOptions: {},
    getLastUpdateId: () => null,
    persistUpdateId: async () => undefined,
    log: params.log ?? (() => undefined),
    telegramTransport: params.telegramTransport,
    stallThresholdMs: params.stallThresholdMs,
    setStatus: params.setStatus,
    isolatedIngress: params.isolatedIngress,
    ...(params.createTelegramTransport
      ? { createTelegramTransport: params.createTelegramTransport }
      : {}),
  });
}

function mockBotCapturingApiMiddleware(botStop: AsyncVoidFn) {
  let apiMiddleware: TelegramApiMiddleware | undefined;
  createTelegramBotMock.mockReturnValueOnce({
    api: {
      deleteWebhook: vi.fn(async () => true),
      getUpdates: vi.fn(async () => []),
      config: {
        use: vi.fn((fn: TelegramApiMiddleware) => {
          apiMiddleware = fn;
        }),
      },
    },
    stop: botStop,
  });
  return () => apiMiddleware;
}

function mockLongRunningPollingCycle(runnerStop: AsyncVoidFn) {
  let firstTaskResolve: (() => void) | undefined;
  runMock.mockReturnValue({
    task: () =>
      new Promise<void>((resolve) => {
        firstTaskResolve = resolve;
      }),
    stop: async () => {
      await runnerStop();
      firstTaskResolve?.();
    },
    isRunning: () => true,
  });
  return () => firstTaskResolve?.();
}

async function waitForApiMiddleware(
  getApiMiddleware: () => TelegramApiMiddleware | undefined,
): Promise<TelegramApiMiddleware> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const apiMiddleware = getApiMiddleware();
    if (apiMiddleware) {
      return apiMiddleware;
    }
    await Promise.resolve();
  }
  throw new Error("Telegram API middleware was not installed");
}

describe("TelegramPollingSession", () => {
  beforeAll(async () => {
    ({ TelegramPollingSession } = await import("./polling-session.js"));
    ({ writeTelegramSpooledUpdate } = await import("./telegram-ingress-spool.js"));
  });

  beforeEach(() => {
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
  });

  it("uses backoff helpers for recoverable polling retries", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: botStop,
    };
    createTelegramBotMock.mockReturnValue(bot);

    let firstCycle = true;
    runMock.mockImplementation(() => {
      if (firstCycle) {
        firstCycle = false;
        return {
          task: async () => {
            throw recoverableError;
          },
          stop: runnerStop,
          isRunning: () => false,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: runnerStop,
        isRunning: () => false,
      };
    });

    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
    });

    await session.runUntilAbort();

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(
      mockObjectArg(createTelegramBotMock, "createTelegramBot").minimumClientTimeoutSeconds,
    ).toBe(45);
    expect(computeBackoffMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("does not call getUpdates for offset confirmation (avoiding 409 conflicts)", async () => {
    const abort = new AbortController();
    const bot = makeBot();
    createTelegramBotMock.mockReturnValueOnce(bot);
    runMock.mockReturnValueOnce({
      task: async () => {
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    });

    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => 41,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
    });

    await session.runUntilAbort();

    // Offset confirmation was removed because it could self-conflict with the runner.
    // OpenClaw middleware still skips duplicates using the persisted update offset.
    expect(bot.api.getUpdates).not.toHaveBeenCalled();
  });

  it("drains isolated ingress spool through the main-thread bot without offset watermark skipping", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const handleUpdate = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      handleUpdate,
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: { update_id: 42, message: { text: "hello" } },
    });
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn(() => () => undefined),
      stop: vi.fn(async () => {
        stopWorker?.();
      }),
      task: vi.fn(async () => {
        await workerDone;
      }),
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 10,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      abort.abort();
      await runPromise;

      expect(createWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          initialUpdateId: null,
          spoolDir: tempDir,
          token: "tok",
        }),
      );
      expect(
        mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset,
      ).toBeUndefined();
      expect(handleUpdate).toHaveBeenCalledWith({ update_id: 42, message: { text: "hello" } });
      await expect(fs.readdir(tempDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forces a restart when polling stalls without getUpdates activity", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const firstRunnerStop = vi.fn(async () => undefined);
    const secondRunnerStop = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: botStop,
    };
    createTelegramBotMock.mockReturnValue(bot);

    let firstTaskResolve: (() => void) | undefined;
    const firstTask = new Promise<void>((resolve) => {
      firstTaskResolve = resolve;
    });
    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      if (cycle === 1) {
        return {
          task: () => firstTask,
          stop: async () => {
            await firstRunnerStop();
            firstTaskResolve?.();
          },
          isRunning: () => true,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: secondRunnerStop,
        isRunning: () => false,
      };
    });

    const watchdogHarness = installPollingStallWatchdogHarness([0, 0, 0, 0, 0]);

    const log = vi.fn();
    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log,
      telegramTransport: undefined,
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(150_001);
      watchdog?.();
      await runPromise;

      expect(runMock).toHaveBeenCalledTimes(2);
      expect(firstRunnerStop).toHaveBeenCalledTimes(1);
      expect(botStop).toHaveBeenCalled();
      expectLogIncludes(log, "Polling stall detected");
      expectLogIncludes(log, "polling stall detected");
    } finally {
      watchdogHarness.restore();
    }
  });

  it("forces a restart when the runner task is pending but reports not running", async () => {
    const abort = new AbortController();
    const firstRunnerStop = vi.fn(async () => undefined);
    const secondRunnerStop = vi.fn(async () => undefined);
    createTelegramBotMock.mockReturnValue(makeBot());

    let firstTaskResolve: (() => void) | undefined;
    const firstTask = new Promise<void>((resolve) => {
      firstTaskResolve = resolve;
    });
    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      if (cycle === 1) {
        return {
          task: () => firstTask,
          stop: async () => {
            await firstRunnerStop();
            firstTaskResolve?.();
          },
          isRunning: () => false,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: secondRunnerStop,
        isRunning: () => false,
      };
    });

    const watchdogHarness = installPollingStallWatchdogHarness();

    const log = vi.fn();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(150_001);
      watchdog?.();
      await runPromise;

      expect(runMock).toHaveBeenCalledTimes(2);
      expect(firstRunnerStop).toHaveBeenCalledTimes(1);
      expectLogIncludes(log, "Polling stall detected");
    } finally {
      watchdogHarness.restore();
    }
  });

  it("honors a custom polling stall threshold", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    mockBotCapturingApiMiddleware(botStop);
    const resolveFirstTask = mockLongRunningPollingCycle(runnerStop);
    const watchdogHarness = installPollingStallWatchdogHarness([0, 0]);

    const log = vi.fn();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      stallThresholdMs: 180_000,
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      watchdog?.();

      expect(runnerStop).not.toHaveBeenCalled();
      expect(botStop).not.toHaveBeenCalled();
      expectLogExcludes(log, "Polling stall detected");

      abort.abort();
      resolveFirstTask();
      await runPromise;
    } finally {
      watchdogHarness.restore();
    }
  });

  it("rebuilds the transport after a stalled polling cycle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const firstBot = makeBot();
    const secondBot = makeBot();
    createTelegramBotMock.mockReturnValueOnce(firstBot).mockReturnValueOnce(secondBot);

    let firstTaskResolve: (() => void) | undefined;
    const firstTask = new Promise<void>((resolve) => {
      firstTaskResolve = resolve;
    });
    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      if (cycle === 1) {
        return {
          task: () => firstTask,
          stop: async () => {
            firstTaskResolve?.();
          },
          isRunning: () => true,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      };
    });

    const watchdogHarness = installPollingStallWatchdogHarness();

    const transport1 = {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    };
    const transport2 = {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close: vi.fn(async () => undefined),
    };
    const createTelegramTransport = vi.fn(() => transport2);

    try {
      const session = new TelegramPollingSession({
        token: "tok",
        config: {},
        accountId: "default",
        runtime: undefined,
        proxyFetch: undefined,
        abortSignal: abort.signal,
        runnerOptions: {},
        getLastUpdateId: () => null,
        persistUpdateId: async () => undefined,
        log: () => undefined,
        telegramTransport: transport1,
        createTelegramTransport,
      });

      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(150_001);
      watchdog?.();
      await runPromise;

      expectTelegramBotTransportSequence(transport1, transport2);
      expect(createTelegramTransport).toHaveBeenCalledTimes(1);
    } finally {
      watchdogHarness.restore();
      vi.useRealTimers();
    }
  });

  it("rebuilds the transport after a recoverable polling error", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const transport1 = makeTelegramTransport();
    const transport2 = makeTelegramTransport();
    const createTelegramTransport = vi.fn(() => transport2);
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    mockRestartAfterPollingError(recoverableError, abort);

    const session = createPollingSessionWithTransportRestart({
      abortSignal: abort.signal,
      telegramTransport: transport1,
      createTelegramTransport,
    });

    await session.runUntilAbort();

    expectTelegramBotTransportSequence(transport1, transport2);
    expect(createTelegramTransport).toHaveBeenCalledTimes(1);
  });

  it("starts polling when webhook cleanup times out during startup", async () => {
    const abort = new AbortController();
    const cleanupError = new Error("Telegram deleteWebhook timed out after 15000ms");
    const bot = makeBot();
    bot.api.deleteWebhook.mockRejectedValueOnce(cleanupError);
    createTelegramBotMock.mockReturnValueOnce(bot);
    runMock.mockReturnValueOnce({
      task: async () => {
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    });

    const session = createPollingSession({
      abortSignal: abort.signal,
    });

    await session.runUntilAbort();

    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("does not trigger stall restart shortly after a getUpdates error", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const getApiMiddleware = mockBotCapturingApiMiddleware(botStop);
    const resolveFirstTask = mockLongRunningPollingCycle(runnerStop);

    const watchdogHarness = installPollingStallWatchdogHarness([0, 0, 1, 30_000]);

    const log = vi.fn();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();

      const apiMiddleware = getApiMiddleware();
      if (apiMiddleware) {
        const failedGetUpdates = vi.fn(async () => {
          throw new Error("Network request for 'getUpdates' failed!");
        });
        await expect(apiMiddleware(failedGetUpdates, "getUpdates", { offset: 1 })).rejects.toThrow(
          "Network request for 'getUpdates' failed!",
        );
      }

      watchdog?.();

      expect(runnerStop).not.toHaveBeenCalled();
      expect(botStop).not.toHaveBeenCalled();
      expectLogExcludes(log, "Polling stall detected");

      abort.abort();
      resolveFirstTask();
      await runPromise;
    } finally {
      watchdogHarness.restore();
    }
  });

  it("publishes polling liveness after getUpdates succeeds", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const setStatus = vi.fn();
    const getApiMiddleware = mockBotCapturingApiMiddleware(botStop);
    const resolveFirstTask = mockLongRunningPollingCycle(runnerStop);

    const session = createPollingSession({
      abortSignal: abort.signal,
      setStatus,
    });

    const runPromise = session.runUntilAbort();

    const apiMiddleware = await waitForApiMiddleware(getApiMiddleware);
    const fakeGetUpdates = vi.fn(async () => []);
    await apiMiddleware(fakeGetUpdates, "getUpdates", { offset: 1 });

    expect(setStatus).toHaveBeenCalledWith({
      mode: "polling",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastTransportActivityAt: null,
    });
    const connectedPatch = statusPatches(setStatus).find((patch) => patch.connected === true);
    expectPollingConnectedPatch(connectedPatch);
    expect(connectedPatch?.lastConnectedAt).toBeTypeOf("number");
    expect(connectedPatch?.lastEventAt).toBeTypeOf("number");
    expect(connectedPatch?.lastTransportActivityAt).toBeTypeOf("number");
    expect(connectedPatch?.lastError).toBeNull();
    expect(connectedPatch?.lastConnectedAt).toBe(connectedPatch?.lastEventAt);
    expect(connectedPatch?.lastTransportActivityAt).toBe(connectedPatch?.lastEventAt);

    abort.abort();
    resolveFirstTask();
    await runPromise;

    expect(setStatus).toHaveBeenLastCalledWith({
      mode: "polling",
      connected: false,
    });
  });

  it("keeps polling marked connected across recoverable restart cycles", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const setStatus = vi.fn();
    let apiMiddleware: TelegramApiMiddleware | undefined;
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: {
          use: vi.fn((fn: TelegramApiMiddleware) => {
            apiMiddleware = fn;
          }),
        },
      },
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValue(bot);

    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      if (cycle === 1) {
        return {
          task: async () => {
            const middleware = apiMiddleware;
            if (!middleware) {
              throw new Error("Telegram API middleware was not installed");
            }
            await middleware(
              vi.fn(async () => []),
              "getUpdates",
              { offset: 1 },
            );
            throw recoverableError;
          },
          stop: vi.fn(async () => undefined),
          isRunning: () => false,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      };
    });

    const session = createPollingSession({
      abortSignal: abort.signal,
      setStatus,
    });

    await session.runUntilAbort();

    expect(runMock).toHaveBeenCalledTimes(2);
    expectPollingConnectedPatch(statusPatches(setStatus).find((patch) => patch.connected === true));
    const disconnectedPatches = statusPatches(setStatus).filter(
      (patch) => patch.connected === false,
    );
    expect(disconnectedPatches).toHaveLength(2);
    expect(disconnectedPatches[0]?.mode).toBe("polling");
    expect(disconnectedPatches[0]?.lastConnectedAt).toBeNull();
    expect(disconnectedPatches[0]?.lastEventAt).toBeNull();
    expect(disconnectedPatches[0]?.lastTransportActivityAt).toBeNull();
    expect(disconnectedPatches[1]).toEqual({
      mode: "polling",
      connected: false,
    });
  });

  it("triggers stall restart even after a non-getUpdates API call succeeds", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const getApiMiddleware = mockBotCapturingApiMiddleware(botStop);
    const resolveFirstTask = mockLongRunningPollingCycle(runnerStop);

    const watchdogHarness = installPollingStallWatchdogHarness();

    const log = vi.fn();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();

      const apiMiddleware = getApiMiddleware();
      if (apiMiddleware) {
        watchdogHarness.setNow(0);
        await apiMiddleware(
          vi.fn(async () => []),
          "getUpdates",
          { offset: 1 },
        );

        watchdogHarness.setNow(150_001);
        const fakePrev = vi.fn(async () => ({ ok: true }));
        await apiMiddleware(fakePrev, "sendMessage", { chat_id: 123, text: "hello" });
      }

      watchdogHarness.setNow(150_001);
      watchdog?.();
      await Promise.resolve();

      expect(runnerStop).toHaveBeenCalledTimes(1);
      expect(botStop).toHaveBeenCalledTimes(1);
      expectLogIncludes(log, "Polling stall detected");

      abort.abort();
      resolveFirstTask();
      await runPromise;
    } finally {
      watchdogHarness.restore();
    }
  });

  it("rebuilds the transport after a getUpdates conflict to force a fresh TCP socket", async () => {
    // Regression for #69787: Telegram-side session termination returns 409
    // and the previous behavior retried on the same HTTP keep-alive socket,
    // which Telegram repeatedly terminated as the "old" session — producing
    // a sustained low-rate 409 loop. The polling session must now mark the
    // transport dirty on 409 so the next cycle uses a fresh connection.
    const abort = new AbortController();
    const conflictError = Object.assign(
      new Error("Conflict: terminated by other getUpdates request"),
      {
        error_code: 409,
        method: "getUpdates",
      },
    );
    const transport1 = makeTelegramTransport();
    const transport2 = makeTelegramTransport();
    const createTelegramTransport = vi
      .fn<() => ReturnType<typeof makeTelegramTransport>>()
      .mockReturnValueOnce(transport2);
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);
    mockRestartAfterPollingError(conflictError, abort);

    const session = createPollingSessionWithTransportRestart({
      abortSignal: abort.signal,
      telegramTransport: transport1,
      createTelegramTransport,
    });

    await session.runUntilAbort();

    expect(createTelegramTransport).toHaveBeenCalledTimes(1);
    expectTelegramBotTransportSequence(transport1, transport2);
    // The stale transport is closed by the dirty-rebuild; the new transport
    // is closed when dispose() fires on session exit.
    expect(transport1.close).toHaveBeenCalledTimes(1);
    expect(transport2.close).toHaveBeenCalledTimes(1);
  });

  it("logs an actionable duplicate-poller hint for getUpdates conflicts", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    const conflictError = Object.assign(
      new Error("Conflict: terminated by other getUpdates request"),
      {
        error_code: 409,
        method: "getUpdates",
      },
    );
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);
    mockRestartAfterPollingError(conflictError, abort);

    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
    });

    await session.runUntilAbort();

    expectLogIncludes(log, "Another OpenClaw gateway, script, or Telegram poller");
  });

  it("logs polling cycle start after a transport rebuild", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    const recoverableError = new Error("recoverable polling error");
    const transport1 = makeTelegramTransport();
    const transport2 = makeTelegramTransport();
    const createTelegramTransport = vi
      .fn<() => ReturnType<typeof makeTelegramTransport>>()
      .mockReturnValueOnce(transport2);
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    mockRestartAfterPollingError(recoverableError, abort);

    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      telegramTransport: transport1,
      createTelegramTransport,
    });

    await session.runUntilAbort();

    expectLogIncludes(log, "rebuilding transport for next polling cycle");
    expectLogIncludes(log, "polling cycle started");
  });

  it("closes the transport once when runUntilAbort exits normally", async () => {
    const abort = new AbortController();
    const transport = makeTelegramTransport();
    createTelegramBotMock.mockReturnValueOnce(makeBot());
    runMock.mockReturnValueOnce({
      task: async () => {
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    });

    const session = createPollingSession({
      abortSignal: abort.signal,
      telegramTransport: transport,
    });

    await session.runUntilAbort();

    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("closes the stale transport when a rebuild replaces it", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const transport1 = makeTelegramTransport();
    const transport2 = makeTelegramTransport();
    const createTelegramTransport = vi
      .fn<() => ReturnType<typeof makeTelegramTransport>>()
      .mockReturnValueOnce(transport2);
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    mockRestartAfterPollingError(recoverableError, abort);

    const session = createPollingSessionWithTransportRestart({
      abortSignal: abort.signal,
      telegramTransport: transport1,
      createTelegramTransport,
    });

    await session.runUntilAbort();

    // Dirty-rebuild closes transport1 (fire-and-forget via #closeTransportAsync).
    // dispose() closes transport2 since it becomes the held transport after the rebuild.
    expect(transport1.close).toHaveBeenCalled();
    expect(transport2.close).toHaveBeenCalled();
  });
});
