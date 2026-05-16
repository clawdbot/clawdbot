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
const drainPendingDeliveriesMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));

vi.mock("@grammyjs/runner", () => ({
  run: runMock,
}));

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
}));

vi.mock("./network-errors.js", () => ({
  isRecoverableTelegramNetworkError: isRecoverableTelegramNetworkErrorMock,
}));

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  drainPendingDeliveries: drainPendingDeliveriesMock,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  computeBackoff: computeBackoffMock,
  createSubsystemLogger: vi.fn(() => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      isEnabled: vi.fn(() => false),
      child: vi.fn(() => logger),
    };
    return logger;
  }),
  formatDurationPrecise: vi.fn((ms: number) => `${ms}ms`),
  sleepWithAbort: sleepWithAbortMock,
}));

let TelegramPollingSession: typeof import("./polling-session.js").TelegramPollingSession;
let claimTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.js").claimTelegramSpooledUpdate;
let listTelegramSpooledUpdates: typeof import("./telegram-ingress-spool.js").listTelegramSpooledUpdates;
let writeTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.js").writeTelegramSpooledUpdate;

type TelegramApiMiddleware = (
  prev: (...args: unknown[]) => Promise<unknown>,
  method: string,
  payload: unknown,
) => Promise<unknown>;
type DrainPendingDeliveriesCall = {
  drainKey: string;
  logLabel: string;
  selectEntry: (
    entry: {
      channel: string;
      accountId?: string;
      lastError?: string;
    },
    now: number,
  ) => { match: boolean; bypassBackoff: boolean };
};
type WorkerPollSuccessListener = (message: {
  type: "poll-success";
  offset: null;
  count: number;
  finishedAt: number;
}) => void;
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

function expectDrainPendingDeliveriesCall(index = 0): DrainPendingDeliveriesCall {
  const call = drainPendingDeliveriesMock.mock.calls[index]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error(`Expected drainPendingDeliveries call ${index}`);
  }
  return call as DrainPendingDeliveriesCall;
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

type TestTelegramUpdate = {
  update_id: number;
  message: {
    text: string;
    chat: { id: number; type: "supergroup" };
    message_thread_id?: number;
    is_topic_message?: boolean;
  };
};

function topicUpdate(updateId: number, threadId: number, text: string): TestTelegramUpdate {
  return {
    update_id: updateId,
    message: {
      text,
      message_thread_id: threadId,
      is_topic_message: true,
      chat: { id: -100, type: "supergroup" },
    },
  };
}

async function writeSpooledTestUpdates(
  spoolDir: string,
  updates: readonly TestTelegramUpdate[],
): Promise<void> {
  for (const update of updates) {
    await writeTelegramSpooledUpdate({ spoolDir, update });
  }
}

async function pendingUpdateIds(spoolDir: string, limit: number | "all" = 100): Promise<number[]> {
  return (await listTelegramSpooledUpdates({ spoolDir, limit })).map((update) => update.updateId);
}

async function withTempSpool<T>(fn: (spoolDir: string) => Promise<T>): Promise<T> {
  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  try {
    return await fn(spoolDir);
  } finally {
    await fs.rm(spoolDir, { recursive: true, force: true });
  }
}

function createIdleIngressWorker() {
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
  return {
    createWorker,
    stop: () => stopWorker?.(),
  };
}

function startIsolatedIngressSession(params: {
  abort: AbortController;
  spoolDir: string;
  handleUpdate: (update: { update_id?: number }) => Promise<void>;
  drainIntervalMs?: number;
  log?: (message: string) => void;
  stop?: () => Promise<void>;
}) {
  const worker = createIdleIngressWorker();
  const bot = {
    api: {
      deleteWebhook: vi.fn(async () => true),
      config: { use: vi.fn() },
    },
    init: vi.fn(async () => undefined),
    handleUpdate: vi.fn(params.handleUpdate),
    stop: vi.fn(params.stop ?? (async () => undefined)),
  };
  createTelegramBotMock.mockReturnValueOnce(bot);
  const session = createPollingSession({
    abortSignal: params.abort.signal,
    log: params.log,
    isolatedIngress: {
      enabled: true,
      spoolDir: params.spoolDir,
      createWorker: worker.createWorker,
      drainIntervalMs: params.drainIntervalMs ?? 10,
    },
  });
  return {
    bot,
    createWorker: worker.createWorker,
    runPromise: session.runUntilAbort(),
    stopWorker: worker.stop,
  };
}

describe("TelegramPollingSession", () => {
  beforeAll(async () => {
    ({ TelegramPollingSession } = await import("./polling-session.js"));
    ({ claimTelegramSpooledUpdate, listTelegramSpooledUpdates, writeTelegramSpooledUpdate } =
      await import("./telegram-ingress-spool.js"));
  });

  beforeEach(() => {
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
    drainPendingDeliveriesMock.mockReset().mockResolvedValue(undefined);
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

  it("initializes the main-thread bot before draining isolated ingress spool", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const handleUpdate = vi.fn(async () => undefined);
    const init = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init,
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
      await vi.waitFor(async () => expect(await fs.readdir(tempDir)).toEqual([]));
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
      expect(init).toHaveBeenCalledBefore(handleUpdate);
      expect(handleUpdate).toHaveBeenCalledWith({ update_id: 42, message: { text: "hello" } });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drains Telegram delivery queue after isolated ingress reports poll success", async () => {
    const abort = new AbortController();
    const init = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init,
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    let onMessage:
      | ((message: { type: "poll-success"; finishedAt: number; count: number }) => void)
      | undefined;
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((handler) => {
        onMessage = handler;
        return () => undefined;
      }),
      stop: vi.fn(async () => {
        stopWorker?.();
      }),
      task: vi.fn(async () => {
        await workerDone;
      }),
    }));

    const session = createPollingSession({
      abortSignal: abort.signal,
      isolatedIngress: {
        enabled: true,
        createWorker,
        drainIntervalMs: 10,
      },
    });

    const runPromise = session.runUntilAbort();
    await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    onMessage?.({ type: "poll-success", finishedAt: Date.now(), count: 0 });

    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1));

    abort.abort();
    await runPromise;
  });

  it("keeps failed lanes blocked for the rest of the drain pass", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "first topic 10 turn"),
        topicUpdate(43, 11, "topic 11 turn"),
        topicUpdate(44, 10, "second topic 10 turn"),
      ]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 500,
        handleUpdate: async (update) => {
          if (update.update_id === 42) {
            events.push("topic10:first");
            throw new Error("handler boom");
          }
          if (update.update_id === 43) {
            events.push("topic11");
            return;
          }
          if (update.update_id === 44) {
            events.push("topic10:second");
          }
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["topic10:first", "topic11"]));
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([42, 44]);
      expectLogIncludes(log, "spooled update 42 failed; keeping for retry");
      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("recovers restart processing claims before draining later same-lane updates", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "interrupted topic 10 turn"),
        topicUpdate(43, 10, "later topic 10 turn"),
        topicUpdate(44, 11, "topic 11 turn"),
      ]);
      const interrupted = (await listTelegramSpooledUpdates({ spoolDir: tempDir })).find(
        (update) => update.updateId === 42,
      );
      if (!interrupted) {
        throw new Error("Expected interrupted update");
      }
      await claimTelegramSpooledUpdate(interrupted);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          events.push(`handled:${update.update_id}`);
          if (update.update_id === 44) {
            abort.abort();
          }
        },
      });

      await runPromise;
      expect(events).toEqual(["handled:42", "handled:44"]);
      expect(await pendingUpdateIds(tempDir)).toEqual([43]);
      expect((await fs.readdir(tempDir)).toSorted()).toEqual(["0000000000000043.json"]);
      stopWorker();
    });
  });

  it("recovers unowned processing claims after the initial drain", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(40, 11, "warmup topic 11 turn")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          events.push(`handled:${update.update_id}`);
          if (update.update_id === 42) {
            abort.abort();
          }
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["handled:40"]));
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir)).toEqual([]));

      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "interrupted topic 10 turn"),
        topicUpdate(43, 10, "later topic 10 turn"),
      ]);
      const interrupted = (await listTelegramSpooledUpdates({ spoolDir: tempDir })).find(
        (update) => update.updateId === 42,
      );
      if (!interrupted) {
        throw new Error("Expected interrupted update");
      }
      await claimTelegramSpooledUpdate(interrupted);

      await runPromise;
      expect(events).toEqual(["handled:40", "handled:42"]);
      expect(await pendingUpdateIds(tempDir)).toEqual([43]);
      stopWorker();
    });
  });

  it("keeps claims owned by another live process blocked", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      const interruptedUpdate = topicUpdate(42, 10, "active topic 10 turn");
      await writeSpooledTestUpdates(tempDir, [
        interruptedUpdate,
        topicUpdate(43, 10, "later topic 10 turn"),
      ]);
      const interrupted = (await listTelegramSpooledUpdates({ spoolDir: tempDir })).find(
        (update) => update.updateId === 42,
      );
      if (!interrupted) {
        throw new Error("Expected interrupted update");
      }
      const claimed = await claimTelegramSpooledUpdate(interrupted);
      if (!claimed) {
        throw new Error("Expected claimed update");
      }
      await fs.writeFile(
        claimed.path,
        `${JSON.stringify({
          version: 1,
          updateId: 42,
          receivedAt: interrupted.receivedAt,
          update: interruptedUpdate,
          claim: {
            processId: "other-process",
            processPid: process.pid,
            claimedAt: Date.now(),
          },
        })}\n`,
        { mode: 0o600 },
      );

      const { createWorker, runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          events.push(`handled:${update.update_id}`);
        },
      });

      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual([]);
      expect(await pendingUpdateIds(tempDir)).toEqual([43]);
      expect((await fs.readdir(tempDir)).toSorted()).toEqual([
        "0000000000000042.json.processing",
        "0000000000000043.json",
      ]);
      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("scans past active-lane backlogs to start unrelated lanes", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseTopicTenTurn: (() => void) | undefined;
      const topicTenTurnDone = new Promise<void>((resolve) => {
        releaseTopicTenTurn = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [topicUpdate(0, 10, "active topic 10 turn")]);
      for (let updateId = 1; updateId <= 100; updateId += 1) {
        await writeTelegramSpooledUpdate({
          spoolDir: tempDir,
          update: topicUpdate(updateId, 10, `blocked topic 10 turn ${updateId}`),
        });
      }
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: topicUpdate(101, 11, "topic 11 turn"),
      });

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          if (update.update_id === 0) {
            events.push("topic10:start");
            await topicTenTurnDone;
            events.push("topic10:end");
            return;
          }
          if (update.update_id === 101) {
            events.push("handled:101");
            abort.abort();
          }
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["topic10:start", "handled:101"]));
      releaseTopicTenTurn?.();
      await runPromise;
      expect(events).toEqual(["topic10:start", "handled:101", "topic10:end"]);
      releaseTopicTenTurn?.();
      stopWorker();
    });
  });

  it("lets isolated ingress drain interleave different Telegram topic lanes", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const events: string[] = [];
    let releaseTopicTenTurn: (() => void) | undefined;
    const topicTenTurnDone = new Promise<void>((resolve) => {
      releaseTopicTenTurn = resolve;
    });
    const handleUpdate = vi.fn(async (update: { update_id?: number }) => {
      if (update.update_id === 42) {
        events.push("topic10:start");
        await topicTenTurnDone;
        events.push("topic10:end");
        return;
      }
      if (update.update_id === 43) {
        events.push("topic11");
        return;
      }
      if (update.update_id === 44) {
        events.push("topic10:second");
      }
    });
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    for (const { updateId, threadId, text } of [
      { updateId: 42, threadId: 10, text: "long topic 10 turn" },
      { updateId: 43, threadId: 11, text: "topic 11 turn" },
      { updateId: 44, threadId: 10, text: "second topic 10 turn" },
    ]) {
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: {
          update_id: updateId,
          message: {
            text,
            message_thread_id: threadId,
            is_topic_message: true,
            chat: { id: -100, type: "supergroup" },
          },
        },
      });
    }
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
      await vi.waitFor(() => expect(events).toEqual(["topic10:start", "topic11"]));
      expect(
        (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map((update) => update.updateId),
      ).toEqual([44]);

      releaseTopicTenTurn?.();
      await vi.waitFor(() =>
        expect(events).toEqual(["topic10:start", "topic11", "topic10:end", "topic10:second"]),
      );
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      abort.abort();
      await runPromise;
    } finally {
      releaseTopicTenTurn?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets isolated ingress drain interleave different Telegram chats", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const events: string[] = [];
    let releaseFirstChatTurn: (() => void) | undefined;
    const firstChatTurnDone = new Promise<void>((resolve) => {
      releaseFirstChatTurn = resolve;
    });
    const handleUpdate = vi.fn(async (update: { update_id?: number }) => {
      if (update.update_id === 42) {
        events.push("chatA:start");
        await firstChatTurnDone;
        events.push("chatA:end");
        return;
      }
      if (update.update_id === 43) {
        events.push("chatB");
        return;
      }
      if (update.update_id === 44) {
        events.push("chatA:second");
      }
    });
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    for (const { updateId, chatId, text } of [
      { updateId: 42, chatId: -100, text: "long first chat turn" },
      { updateId: 43, chatId: 854067528, text: "second chat turn" },
      { updateId: 44, chatId: -100, text: "second first chat turn" },
    ]) {
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: {
          update_id: updateId,
          message: {
            text,
            chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
          },
        },
      });
    }
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
      await vi.waitFor(() => expect(events).toEqual(["chatA:start", "chatB"]));
      expect(
        (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map((update) => update.updateId),
      ).toEqual([44]);

      releaseFirstChatTurn?.();
      await vi.waitFor(() =>
        expect(events).toEqual(["chatA:start", "chatB", "chatA:end", "chatA:second"]),
      );
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      abort.abort();
      await runPromise;
    } finally {
      releaseFirstChatTurn?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets isolated ingress control updates bypass an active spooled turn", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const events: string[] = [];
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async (update: { update_id?: number }) => {
      if (update.update_id === 42) {
        events.push("regular:start");
        await regularTurnDone;
        events.push("regular:end");
        return;
      }
      if (update.update_id === 43) {
        events.push("status");
      }
      if (update.update_id === 44) {
        events.push("stop");
      }
    });
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: {
        update_id: 42,
        message: {
          text: "summarize this",
          chat: { id: -100, type: "supergroup", is_forum: true },
          is_topic_message: true,
          message_thread_id: 5907,
        },
      },
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
      await vi.waitFor(() => expect(events).toEqual(["regular:start"]));
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: {
          update_id: 43,
          message: {
            text: "/status",
            chat: { id: -100, type: "supergroup", is_forum: true },
            is_topic_message: true,
            message_thread_id: 5907,
          },
        },
      });
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: {
          update_id: 44,
          message: {
            text: "/stop@vacs_tars_bot",
            chat: { id: -100, type: "supergroup", is_forum: true },
            is_topic_message: true,
            message_thread_id: 5907,
          },
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["regular:start", "status", "stop"]));
      expect(
        (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map((update) => update.updateId),
      ).toEqual([]);

      releaseRegularTurn?.();
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      abort.abort();
      await runPromise;
    } finally {
      releaseRegularTurn?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves spool order when a control update is already queued after a regular turn", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const events: string[] = [];
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async (update: { update_id?: number }) => {
      if (update.update_id === 42) {
        events.push("regular:start");
        await regularTurnDone;
        events.push("regular:end");
        return;
      }
      if (update.update_id === 43) {
        events.push("status");
      }
    });
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: {
        update_id: 42,
        message: { text: "summarize this", chat: { id: -100, type: "supergroup" } },
      },
    });
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: {
        update_id: 43,
        message: { text: "/status", chat: { id: -100, type: "supergroup" } },
      },
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
      await vi.waitFor(() => expect(events).toEqual(["regular:start", "status"]));

      releaseRegularTurn?.();
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      abort.abort();
      await runPromise;
    } finally {
      releaseRegularTurn?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for active spooled handlers before stopping the bot", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const events: string[] = [];
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      events.push("regular:start");
      await regularTurnDone;
      events.push("regular:end");
    });
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => {
        events.push("bot:stop");
      }),
    };
    createTelegramBotMock.mockReturnValueOnce(bot);
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: {
        update_id: 42,
        message: { text: "summarize this", chat: { id: -100, type: "supergroup" } },
      },
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
      await vi.waitFor(() => expect(events).toEqual(["regular:start"]));
      abort.abort();
      releaseRegularTurn?.();
      await runPromise;

      expect(events).toEqual(["regular:start", "regular:end", "bot:stop"]);
    } finally {
      releaseRegularTurn?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps active spooled lanes blocked across isolated ingress restarts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      await regularTurnDone;
    });
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    }));
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: {
        update_id: 42,
        message: { text: "summarize this", chat: { id: -100, type: "supergroup" } },
      },
    });

    let workerTaskCalls = 0;
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
        workerTaskCalls += 1;
        if (workerTaskCalls === 1) {
          return;
        }
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
          drainIntervalMs: 100,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(16_000);
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      expect(handleUpdate).toHaveBeenCalledTimes(1);

      releaseRegularTurn?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
    } finally {
      releaseRegularTurn?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps active spooled lanes blocked across account restarts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      await regularTurnDone;
    });
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    }));
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: {
        update_id: 42,
        message: { text: "summarize this", chat: { id: -100, type: "supergroup" } },
      },
    });

    const createWorker = vi.fn(() => {
      let stopWorker: (() => void) | undefined;
      const workerDone = new Promise<void>((resolve) => {
        stopWorker = resolve;
      });
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => {
          stopWorker?.();
        }),
        task: vi.fn(async () => {
          await workerDone;
        }),
      };
    });

    try {
      const firstSession = createPollingSession({
        abortSignal: firstAbort.signal,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      const firstRunPromise = firstSession.runUntilAbort();
      await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      firstAbort.abort();
      await vi.advanceTimersByTimeAsync(16_000);
      await firstRunPromise;

      const secondSession = createPollingSession({
        abortSignal: secondAbort.signal,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });
      const secondRunPromise = secondSession.runUntilAbort();
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handleUpdate).toHaveBeenCalledTimes(1);

      releaseRegularTurn?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      secondAbort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await secondRunPromise;
    } finally {
      releaseRegularTurn?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks isolated ingress unhealthy when a spooled backlog wedges while polling stays live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      await regularTurnDone;
    });
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    }));
    for (const updateId of [42, 43]) {
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: {
          update_id: updateId,
          message: { text: `dm ${updateId}`, chat: { id: 123, type: "private" } },
        },
      });
    }

    const workerListeners: WorkerPollSuccessListener[] = [];
    const createWorker = vi.fn(() => {
      let stopWorker: (() => void) | undefined;
      const workerDone = new Promise<void>((resolve) => {
        stopWorker = resolve;
      });
      return {
        onMessage: vi.fn((listener: WorkerPollSuccessListener) => {
          workerListeners.push(listener);
          return () => undefined;
        }),
        stop: vi.fn(async () => {
          stopWorker?.();
        }),
        task: vi.fn(async () => {
          await workerDone;
        }),
      };
    });

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        setStatus,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      workerListeners[0]?.({
        type: "poll-success",
        offset: null,
        count: 0,
        finishedAt: Date.now(),
      });
      expect(statusPatches(setStatus).some((patch) => patch.connected === true)).toBe(true);

      await vi.advanceTimersByTimeAsync(25 * 60_000 + 100);

      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("isolated polling spool backlog stalled"),
        ),
      );
      expect(
        statusPatches(setStatus).some(
          (patch) =>
            patch.connected === false &&
            String(patch.lastError).includes("isolated polling spool backlog stalled"),
        ),
      ).toBe(true);
      workerListeners[0]?.({
        type: "poll-success",
        offset: null,
        count: 0,
        finishedAt: Date.now(),
      });
      expect(statusPatches(setStatus).at(-1)?.connected).toBe(false);

      releaseRegularTurn?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdates({ spoolDir: tempDir })).map(
            (update) => update.updateId,
          ),
        ).toEqual([]),
      );
      workerListeners[0]?.({
        type: "poll-success",
        offset: null,
        count: 0,
        finishedAt: Date.now(),
      });
      await vi.waitFor(() => expect(statusPatches(setStatus).at(-1)?.connected).toBe(true));
      expect(createWorker).toHaveBeenCalledTimes(1);

      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
    } finally {
      releaseRegularTurn?.();
      vi.useRealTimers();
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

  it("drains Telegram delivery queue after getUpdates confirms polling reconnect", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const getApiMiddleware = mockBotCapturingApiMiddleware(botStop);
    const resolveFirstTask = mockLongRunningPollingCycle(runnerStop);

    const session = createPollingSession({
      abortSignal: abort.signal,
    });

    const runPromise = session.runUntilAbort();
    const apiMiddleware = await waitForApiMiddleware(getApiMiddleware);
    await apiMiddleware(
      vi.fn(async () => []),
      "getUpdates",
      { offset: 1 },
    );

    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1));
    const drain = expectDrainPendingDeliveriesCall();
    expect(drain.drainKey).toBe("telegram:default");
    expect(drain.logLabel).toBe("Telegram reconnect drain");
    expect(drain.selectEntry({ channel: "telegram" }, Date.now())).toEqual({
      match: true,
      bypassBackoff: false,
    });
    expect(
      drain.selectEntry(
        {
          channel: "telegram",
          accountId: "default",
          lastError: "Network request for 'sendMessage' failed!",
        },
        Date.now(),
      ),
    ).toEqual({
      match: true,
      bypassBackoff: false,
    });
    expect(drain.selectEntry({ channel: "telegram", accountId: "alerts" }, Date.now()).match).toBe(
      false,
    );
    expect(drain.selectEntry({ channel: "whatsapp" }, Date.now()).match).toBe(false);

    abort.abort();
    resolveFirstTask();
    await runPromise;
  });

  it("drains Telegram delivery queue after each getUpdates success", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const getApiMiddleware = mockBotCapturingApiMiddleware(botStop);
    const resolveFirstTask = mockLongRunningPollingCycle(runnerStop);

    const session = createPollingSession({
      abortSignal: abort.signal,
    });

    const runPromise = session.runUntilAbort();
    const apiMiddleware = await waitForApiMiddleware(getApiMiddleware);
    await apiMiddleware(
      vi.fn(async () => []),
      "getUpdates",
      { offset: 1 },
    );
    await apiMiddleware(
      vi.fn(async () => []),
      "getUpdates",
      { offset: 2 },
    );

    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(2));

    abort.abort();
    resolveFirstTask();
    await runPromise;
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
