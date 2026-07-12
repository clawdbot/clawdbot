// Telegram tests cover polling session plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";
import type { TelegramIngressWorkerMessage } from "./telegram-ingress-worker.js";

const runMock = vi.hoisted(() => vi.fn());
const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const computeBackoffMock = vi.hoisted(() =>
  vi.fn((_policy: { initialMs: number }, _attempt: number) => 0),
);
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
let pollingSessionTesting: typeof import("./polling-session.js").testing;
let claimTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.js").claimTelegramSpooledUpdate;
let isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess: typeof import("./telegram-ingress-spool.js").isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess;
let listTelegramSpooledUpdateClaims: typeof import("./telegram-ingress-spool.js").listTelegramSpooledUpdateClaims;
let listTelegramSpooledUpdates: typeof import("./telegram-ingress-spool.js").listTelegramSpooledUpdates;
let recoverStaleTelegramSpooledUpdateClaims: typeof import("./telegram-ingress-spool.js").recoverStaleTelegramSpooledUpdateClaims;
let telegramSpooledUpdateClaimLeaseMs: typeof import("./telegram-ingress-spool.js").TELEGRAM_SPOOLED_UPDATE_CLAIM_LEASE_MS;
let writeTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.js").writeTelegramSpooledUpdate;
let createTelegramSpooledReplayDeferredParticipant: typeof import("./bot-processing-outcome.js").createTelegramSpooledReplayDeferredParticipant;
let TelegramMessageDispatchReplayForgetError: typeof import("./message-dispatch-dedupe.js").TelegramMessageDispatchReplayForgetError;
type TelegramMessageProcessingResult =
  import("./bot-processing-outcome.js").TelegramMessageProcessingResult;
type TelegramSpooledReplayDeferredParticipant =
  import("./bot-processing-outcome.js").TelegramSpooledReplayDeferredParticipant;
type TelegramSpooledReplaySettlementHold =
  import("./bot-processing-outcome.js").TelegramSpooledReplaySettlementHold;
let beginTelegramReplyFence: typeof import("./telegram-reply-fence.js").beginTelegramReplyFence;
let buildTelegramReplyFenceLaneKey: typeof import("./telegram-reply-fence.js").buildTelegramReplyFenceLaneKey;
let endTelegramReplyFence: typeof import("./telegram-reply-fence.js").endTelegramReplyFence;
let resetTelegramReplyFenceForTests: typeof import("./telegram-reply-fence.js").resetTelegramReplyFenceForTests;

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
type WorkerPollErrorListener = (message: {
  type: "poll-error";
  message: string;
  errorCode?: number;
  finishedAt: number;
}) => void;
type WorkerMessageListener = (message: TelegramIngressWorkerMessage) => void;
type AsyncVoidFn = () => Promise<void>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
type TelegramPollingTestDatabase = Pick<
  OpenClawStateKyselyDatabaseForTests,
  "channel_ingress_events"
>;

const POLLING_TEST_WATCHDOG_INTERVAL_MS = 30_000;

function installTelegramIngressQueueRuntime(resolveStateDir: () => string): void {
  setTelegramRuntime({
    state: {
      resolveStateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => createChannelIngressQueue({ ...options, channelId: "telegram" }),
    },
  } as TelegramRuntime);
}

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
  let resolveWatchdog: ((fn: () => void) => void) | undefined;
  const watchdogReady = new Promise<() => void>((resolve) => {
    resolveWatchdog = resolve;
  });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const watchdogs: Array<() => void> = [];
  const watchdogWaiters: Array<{
    count: number;
    resolve: (fn: () => void) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof realSetTimeout>;
  }> = [];
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn, delay) => {
    if (delay === POLLING_TEST_WATCHDOG_INTERVAL_MS) {
      watchdog = fn as () => void;
      watchdogs.push(watchdog);
      resolveWatchdog?.(watchdog);
      for (let index = watchdogWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = expectDefined(watchdogWaiters[index], `watchdog waiter ${index}`);
        if (watchdogs.length < waiter.count) {
          continue;
        }
        realClearTimeout(waiter.timeout);
        watchdogWaiters.splice(index, 1);
        waiter.resolve(
          expectDefined(watchdogs[waiter.count - 1], `watchdog callback ${waiter.count}`),
        );
      }
    }
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((fn) => realSetTimeout(fn as () => void, 0));
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timeoutId) => {
    realClearTimeout(timeoutId);
  });
  const dateNowSpy = vi.spyOn(Date, "now");
  for (const value of dateNowSequence) {
    dateNowSpy.mockImplementationOnce(() => value);
  }
  dateNowSpy.mockImplementation(() => 0);

  return {
    async waitForWatchdog() {
      if (watchdog) {
        return watchdog;
      }
      return await new Promise<() => void>((resolve, reject) => {
        const timeout = realSetTimeout(() => {
          reject(new Error("Timed out waiting for polling watchdog interval registration"));
        }, 5_000);
        watchdogReady.then(
          (fn) => {
            realClearTimeout(timeout);
            resolve(fn);
          },
          (error: unknown) => {
            realClearTimeout(timeout);
            reject(toLintErrorObject(error, "Non-Error rejection"));
          },
        );
      });
    },
    async waitForWatchdogRegistration(count: number) {
      const registered = watchdogs[count - 1];
      if (registered) {
        return registered;
      }
      return await new Promise<() => void>((resolve, reject) => {
        const timeout = realSetTimeout(() => {
          reject(new Error(`Timed out waiting for polling watchdog registration ${count}`));
        }, 5_000);
        watchdogWaiters.push({ count, resolve, reject, timeout });
      });
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
  getLastUpdateId?: () => number | null;
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
    getLastUpdateId: params.getLastUpdateId ?? (() => null),
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
    chat: { id: number; type: "private" | "supergroup" };
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

function directUpdate(updateId: number, chatId: number, text: string): TestTelegramUpdate {
  return {
    update_id: updateId,
    message: {
      text,
      chat: { id: chatId, type: "private" },
    },
  };
}

async function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitForTestReplyFenceAbort(params: { key: string; laneKey: string }): Promise<void> {
  const controller = new AbortController();
  beginTelegramReplyFence({
    key: params.key,
    laneKey: buildTelegramReplyFenceLaneKey({
      accountId: "default",
      sequentialKey: params.laneKey,
    }),
    supersede: false,
    abortController: controller,
  });
  try {
    await waitForAbortSignal(controller.signal);
  } finally {
    endTelegramReplyFence(params.key, controller);
  }
}

async function writeSpooledTestUpdates(
  spoolDir: string,
  updates: readonly TestTelegramUpdate[],
  options?: { now?: number },
): Promise<void> {
  for (const update of updates) {
    await writeTelegramSpooledUpdate({ spoolDir, update, now: options?.now });
  }
}

async function pendingUpdateIds(spoolDir: string, limit: number | "all" = 100): Promise<number[]> {
  return (await listTelegramSpooledUpdates({ spoolDir, limit })).map((update) => update.updateId);
}

async function claimedAtForUpdate(spoolDir: string, updateId: number): Promise<number> {
  const claim = (await listTelegramSpooledUpdateClaims({ spoolDir })).find(
    (entry) => entry.updateId === updateId,
  );
  if (!claim?.claim) {
    throw new Error(`Expected claimed spooled update ${updateId}`);
  }
  return claim.claim.claimedAt;
}

function installSpooledClaimRefreshHarness(): {
  restore: () => void;
  triggerRefresh: () => void;
} {
  let refresh: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: Parameters<typeof setInterval>[0],
    timeout?: number,
  ) => {
    if (timeout === pollingSessionTesting.spooledClaimRefreshIntervalMs) {
      refresh = () => {
        if (typeof handler === "function") {
          handler();
        }
      };
      const timer = realSetInterval(() => undefined, 2_147_483_647);
      timer.unref?.();
      return timer;
    }
    return realSetInterval(handler, timeout);
  }) as typeof setInterval);
  return {
    restore: () => setIntervalSpy.mockRestore(),
    triggerRefresh: () => {
      if (!refresh) {
        throw new Error("Expected spooled claim refresh interval to be registered");
      }
      refresh();
    },
  };
}

function normalizeTelegramTestAccountId(spoolDir: string): string {
  const trimmed = path.basename(spoolDir).trim();
  return trimmed ? trimmed.replace(/[^a-z0-9._-]+/gi, "_") : "default";
}

function telegramTestQueueName(spoolDir: string): string {
  return JSON.stringify(["telegram", normalizeTelegramTestAccountId(spoolDir)]);
}

function openTelegramSpoolTestKysely(spoolDir: string) {
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: spoolDir },
  });
  return {
    database,
    kysely: getNodeSqliteKysely<TelegramPollingTestDatabase>(database.db),
  };
}

async function failedUpdateIds(spoolDir: string): Promise<number[]> {
  const { database, kysely } = openTelegramSpoolTestKysely(spoolDir);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("channel_ingress_events")
      .select("event_id")
      .where("queue_name", "=", telegramTestQueueName(spoolDir))
      .where("status", "=", "failed")
      .orderBy("event_id", "asc"),
  ).rows;
  return rows.map((row) => Number(row.event_id));
}

async function failedUpdateReasons(
  spoolDir: string,
): Promise<Array<{ id: number; reason: string }>> {
  const { database, kysely } = openTelegramSpoolTestKysely(spoolDir);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("channel_ingress_events")
      .select(["event_id", "failed_reason"])
      .where("queue_name", "=", telegramTestQueueName(spoolDir))
      .where("status", "=", "failed")
      .orderBy("event_id", "asc"),
  ).rows;
  return rows.map((row) => ({ id: Number(row.event_id), reason: String(row.failed_reason) }));
}

async function adoptClaimOwner(params: {
  spoolDir: string;
  updateId: number;
  ownerId: string;
  claimedAt: number;
}): Promise<void> {
  const { database, kysely } = openTelegramSpoolTestKysely(params.spoolDir);
  executeSqliteQuerySync(
    database.db,
    kysely
      .updateTable("channel_ingress_events")
      .set({
        claim_owner: params.ownerId,
        claimed_at: params.claimedAt,
        updated_at: params.claimedAt,
      })
      .where("queue_name", "=", telegramTestQueueName(params.spoolDir))
      .where("event_id", "=", String(params.updateId).padStart(16, "0"))
      .where("status", "=", "claimed"),
  );
}

async function withTempSpool<T>(fn: (spoolDir: string) => Promise<T>): Promise<T> {
  const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  try {
    return await fn(spoolDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
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
  spooledUpdateHandlerTimeoutMs?: number;
  spooledUpdateHandlerAbortGraceMs?: number;
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
      ...(params.spooledUpdateHandlerTimeoutMs !== undefined
        ? { spooledUpdateHandlerTimeoutMs: params.spooledUpdateHandlerTimeoutMs }
        : {}),
      ...(params.spooledUpdateHandlerAbortGraceMs !== undefined
        ? { spooledUpdateHandlerAbortGraceMs: params.spooledUpdateHandlerAbortGraceMs }
        : {}),
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
    ({ TelegramPollingSession, testing: pollingSessionTesting } =
      await import("./polling-session.js"));
    ({
      claimTelegramSpooledUpdate,
      isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
      listTelegramSpooledUpdateClaims,
      listTelegramSpooledUpdates,
      recoverStaleTelegramSpooledUpdateClaims,
      TELEGRAM_SPOOLED_UPDATE_CLAIM_LEASE_MS: telegramSpooledUpdateClaimLeaseMs,
      writeTelegramSpooledUpdate,
    } = await import("./telegram-ingress-spool.js"));
    ({ createTelegramSpooledReplayDeferredParticipant } =
      await import("./bot-processing-outcome.js"));
    ({ TelegramMessageDispatchReplayForgetError } = await import("./message-dispatch-dedupe.js"));
    ({
      beginTelegramReplyFence,
      buildTelegramReplyFenceLaneKey,
      endTelegramReplyFence,
      resetTelegramReplyFenceForTests,
    } = await import("./telegram-reply-fence.js"));
  });

  beforeEach(() => {
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
    drainPendingDeliveriesMock.mockReset().mockResolvedValue(undefined);
    resetTelegramReplyFenceForTests();
    installTelegramIngressQueueRuntime(() =>
      path.join(os.tmpdir(), "openclaw-telegram-test-state"),
    );
  });

  afterEach(() => {
    pollingSessionTesting.resetActiveSpooledUpdateHandlersForTests();
    clearTelegramRuntime();
    closeOpenClawStateDatabaseForTest();
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
    expect(computeBackoffMock).toHaveBeenCalledWith(
      {
        initialMs: 30_000,
        maxMs: 600_000,
        factor: 2,
        jitter: 0.2,
      },
      1,
    );
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("resets restart backoff after a healthy polling cycle", () => {
    const state = pollingSessionTesting.createTelegramRestartBackoffState();
    pollingSessionTesting.resolveTelegramRestartDelayMs(state, { stopTimedOut: true });
    pollingSessionTesting.resolveTelegramRestartDelayMs(state, { stopTimedOut: true });
    pollingSessionTesting.resetTelegramRestartBackoffState(state);
    pollingSessionTesting.resolveTelegramRestartDelayMs(state);

    expect(computeBackoffMock.mock.calls.map((call) => call[1])).toEqual([1, 2, 1, 1]);
    expect(
      computeBackoffMock.mock.calls.map((call) => (call[0] as { initialMs: number }).initialMs),
    ).toEqual([30_000, 30_000, 120_000, 30_000]);
  });

  it("backs off every retryable spooled handler failure with an error marker", () => {
    expect(
      pollingSessionTesting.resolveSpooledUpdateRetryDelayMs(
        {
          updateId: 42,
          path: "/tmp/42.json",
          update: { update_id: 42 },
          receivedAt: 0,
          attempts: 1,
          lastAttemptAt: 1_000,
          lastError: "plain TypeError from handler",
        },
        1_999,
      ),
    ).toBe(1);
    expect(
      pollingSessionTesting.resolveSpooledUpdateRetryDelayMs(
        {
          updateId: 43,
          path: "/tmp/43.json",
          update: { update_id: 43 },
          receivedAt: 0,
          attempts: 1,
          lastAttemptAt: 1_000,
        },
        1_999,
      ),
    ).toBe(0);
    expect(
      pollingSessionTesting.resolveSpooledUpdateRetryDelayMs(
        {
          updateId: 44,
          path: "/tmp/44.json",
          update: { update_id: 44 },
          receivedAt: 0,
          attempts: pollingSessionTesting.spooledRetryMaxAttempts,
          lastAttemptAt: 1_000,
          lastError: "state store outage",
        },
        1_999,
      ),
    ).toBeGreaterThan(0);
  });

  it("keeps generic retryable failures pending until they are old enough to dead-letter", () => {
    const update = {
      updateId: 42,
      path: "/tmp/42.json",
      update: { update_id: 42 },
      receivedAt: 1_000,
      attempts: pollingSessionTesting.spooledRetryMaxAttempts - 1,
      lastAttemptAt: 2_000,
      lastError: "state store outage",
    };

    expect(
      pollingSessionTesting.shouldDeadLetterRetryableSpooledUpdate(
        update,
        pollingSessionTesting.spooledRetryMaxAttempts,
        1_000 + pollingSessionTesting.spooledRetryDeadLetterMinAgeMs - 1,
      ),
    ).toBe(false);
    expect(
      pollingSessionTesting.shouldDeadLetterRetryableSpooledUpdate(
        update,
        pollingSessionTesting.spooledRetryMaxAttempts,
        1_000 + pollingSessionTesting.spooledRetryDeadLetterMinAgeMs,
      ),
    ).toBe(true);
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
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn(() => () => undefined),
      stop: vi.fn(async () => undefined),
      task: vi.fn(async () => {
        await waitForAbortSignal(abort.signal);
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
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));
      await vi.waitFor(async () =>
        expect(
          await listTelegramSpooledUpdateClaims({
            spoolDir: tempDir,
          }),
        ).toEqual([]),
      );
      abort.abort();
      await runPromise;

      expect(createWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          initialUpdateId: null,
          spoolDir: tempDir,
          token: "tok",
        }),
      );
      expect(mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset).toEqual({
        lastUpdateId: null,
        persistenceFloorUpdateId: null,
        onUpdateId: expect.any(Function),
      });
      expect(init).toHaveBeenCalledBefore(handleUpdate);
      expect(handleUpdate).toHaveBeenCalledWith({ update_id: 42, message: { text: "hello" } });
    } finally {
      abort.abort();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes isolated worker updates through the main runtime queue", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const handleUpdate = vi.fn(async () => undefined);
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
    let onMessage: WorkerMessageListener | undefined;
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const ackSpooledUpdate = vi.fn();
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((listener: WorkerMessageListener) => {
        onMessage = listener;
        return () => undefined;
      }),
      ackSpooledUpdate,
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
      await vi.waitFor(() => expect(onMessage).toBeDefined());
      onMessage?.({
        type: "update",
        requestId: "write-1",
        update: { update_id: 42, message: { text: "hello" } },
        queued: 1,
      });

      await vi.waitFor(() =>
        expect(ackSpooledUpdate).toHaveBeenCalledWith("write-1", { ok: true, updateId: 42 }),
      );
      await vi.waitFor(() =>
        expect(handleUpdate).toHaveBeenCalledWith({ update_id: 42, message: { text: "hello" } }),
      );
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));
      abort.abort();
      await runPromise;
    } finally {
      abort.abort();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drains worker-spooled updates without waiting for the next drain interval", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const handleUpdate = vi.fn(async () => {
      abort.abort();
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
    let onMessage: WorkerMessageListener | undefined;
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const ackSpooledUpdate = vi.fn();
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((listener: WorkerMessageListener) => {
        onMessage = listener;
        return () => undefined;
      }),
      ackSpooledUpdate,
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
          drainIntervalMs: 60_000,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(onMessage).toBeDefined());
      onMessage?.({
        type: "update",
        requestId: "write-1",
        update: { update_id: 42, message: { text: "hello" } },
        queued: 1,
      });

      await vi.waitFor(() =>
        expect(ackSpooledUpdate).toHaveBeenCalledWith("write-1", { ok: true, updateId: 42 }),
      );
      onMessage?.({ type: "spooled", updateId: 42, queued: 1 });
      await vi.waitFor(() =>
        expect(handleUpdate).toHaveBeenCalledWith({ update_id: 42, message: { text: "hello" } }),
      );
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));
      abort.abort();
      stopWorker?.();
      await runPromise;
    } finally {
      abort.abort();
      stopWorker?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drains worker-spooled updates that arrive during an active drain", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseFirstClaim: (() => void) | undefined;
    let firstClaimStarted: (() => void) | undefined;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    const firstClaimStartedPromise = new Promise<void>((resolve) => {
      firstClaimStarted = resolve;
    });
    let blockedFirstClaim = false;
    setTelegramRuntime({
      state: {
        resolveStateDir: () => tempDir,
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
          return {
            ...queue,
            claimNext: async (...args: Parameters<typeof queue.claimNext>) => {
              if (!blockedFirstClaim) {
                blockedFirstClaim = true;
                firstClaimStarted?.();
                await firstClaimGate;
              }
              return queue.claimNext(...args);
            },
          };
        },
      },
    } as TelegramRuntime);

    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: { update_id: 1, message: { text: "pre-seeded" } },
    });

    const handleUpdate = vi.fn(async () => undefined);

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
    let onMessage: WorkerMessageListener | undefined;
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const ackSpooledUpdate = vi.fn();
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((listener: WorkerMessageListener) => {
        onMessage = listener;
        return () => undefined;
      }),
      ackSpooledUpdate,
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
          drainIntervalMs: 60_000,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(onMessage).toBeDefined());
      await firstClaimStartedPromise;

      onMessage?.({
        type: "update",
        requestId: "write-2",
        update: { update_id: 2, message: { text: "during-drain" } },
        queued: 1,
      });

      await vi.waitFor(() =>
        expect(ackSpooledUpdate).toHaveBeenCalledWith("write-2", { ok: true, updateId: 2 }),
      );
      onMessage?.({ type: "spooled", updateId: 2, queued: 1 });
      releaseFirstClaim?.();
      releaseFirstClaim = undefined;

      await vi.waitFor(() =>
        expect(handleUpdate).toHaveBeenCalledWith({
          update_id: 1,
          message: { text: "pre-seeded" },
        }),
      );
      await vi.waitFor(() =>
        expect(handleUpdate).toHaveBeenCalledWith({
          update_id: 2,
          message: { text: "during-drain" },
        }),
      );
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));
      abort.abort();
      stopWorker?.();
      await runPromise;
    } finally {
      releaseFirstClaim?.();
      abort.abort();
      stopWorker?.();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drains existing isolated ingress spool entries below the persisted offset", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const handleUpdate = vi.fn(async () => undefined);
    createTelegramBotMock.mockReturnValueOnce({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    });
    await writeTelegramSpooledUpdate({
      spoolDir: tempDir,
      update: { update_id: 42, message: { text: "pre-upgrade pending" } },
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
        getLastUpdateId: () => 42,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 10,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));
      await vi.waitFor(async () =>
        expect(
          await listTelegramSpooledUpdateClaims({
            spoolDir: tempDir,
          }),
        ).toEqual([]),
      );
      abort.abort();
      await runPromise;

      expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ initialUpdateId: 42 }));
      expect(mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset).toEqual({
        lastUpdateId: null,
        persistenceFloorUpdateId: 42,
        onUpdateId: expect.any(Function),
      });
      expect(handleUpdate).toHaveBeenCalledWith({
        update_id: 42,
        message: { text: "pre-upgrade pending" },
      });
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
      | ((
          message:
            | { type: "poll-success"; finishedAt: number; count: number }
            | { type: "poll-error"; finishedAt: number; message: string },
        ) => void)
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
    onMessage?.({ type: "poll-success", finishedAt: 10_000, count: 0 });
    onMessage?.({ type: "poll-success", finishedAt: 10_001, count: 0 });

    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    onMessage?.({ type: "poll-success", finishedAt: 15_000, count: 0 });
    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(2));
    onMessage?.({ type: "poll-error", finishedAt: 15_001, message: "offline" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    onMessage?.({ type: "poll-success", finishedAt: 15_002, count: 0 });
    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(3));

    abort.abort();
    await runPromise;
  });

  it("resets restart backoff after isolated ingress reports poll success", async () => {
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
    createTelegramBotMock.mockReturnValue(bot);
    sleepWithAbortMock.mockImplementation(async () => {
      if (sleepWithAbortMock.mock.calls.length >= 2) {
        abort.abort();
      }
    });

    let cycle = 0;
    const createWorker = vi.fn(() => {
      let onMessage: WorkerPollSuccessListener | undefined;
      cycle += 1;
      return {
        onMessage: vi.fn((handler) => {
          onMessage = handler;
          return () => undefined;
        }),
        stop: vi.fn(async () => undefined),
        task: vi.fn(async () => {
          if (cycle === 2) {
            onMessage?.({
              type: "poll-success",
              offset: null,
              finishedAt: Date.now(),
              count: 0,
            });
          }
        }),
      };
    });

    const session = createPollingSession({
      abortSignal: abort.signal,
      isolatedIngress: {
        enabled: true,
        createWorker,
        drainIntervalMs: 10,
      },
    });

    await session.runUntilAbort();

    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(computeBackoffMock.mock.calls.map((call) => call[1])).toEqual([1, 1]);
  });

  it("restarts isolated ingress when worker liveness stalls", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValue(bot);

    let firstWorkerDone: (() => void) | undefined;
    const firstWorkerTask = new Promise<void>((resolve) => {
      firstWorkerDone = resolve;
    });
    const firstWorkerStop = vi.fn(async () => {
      firstWorkerDone?.();
    });
    let workerCycle = 0;
    const createWorker = vi.fn(() => {
      workerCycle += 1;
      if (workerCycle === 1) {
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: firstWorkerStop,
          task: vi.fn(async () => {
            await firstWorkerTask;
          }),
        };
      }
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => undefined),
        task: vi.fn(async () => {
          abort.abort();
        }),
      };
    });
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      stallThresholdMs: 30_000,
      isolatedIngress: {
        enabled: true,
        createWorker,
        drainIntervalMs: 500,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(31_000);
      watchdog?.();

      await vi.waitFor(() => expect(firstWorkerStop).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      await runPromise;

      expectLogIncludes(log, "Polling stall detected");
      expectLogIncludes(log, "isolated polling ingress finished reason=polling stall detected");
      expectLogExcludes(log, "Isolated polling ingress stop timed out");
    } finally {
      watchdogHarness.restore();
      abort.abort();
    }
  });

  it("applies stop-timeout cooldown to isolated ingress forced restarts", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValue(bot);
    computeBackoffMock.mockImplementation((policy: { initialMs: number }, attempt: number) => {
      if (policy.initialMs === 120_000) {
        return attempt * 100_000;
      }
      return attempt * 1_000;
    });

    const finishStoppedWorkers: Array<() => void> = [];
    let workerCycle = 0;
    const createWorker = vi.fn(() => {
      workerCycle += 1;
      if (workerCycle <= 2) {
        let finishTask: (() => void) | undefined;
        const task = new Promise<void>((resolve) => {
          finishTask = resolve;
        });
        let finishStop: (() => void) | undefined;
        const stop = new Promise<void>((resolve) => {
          finishStop = resolve;
        });
        finishStoppedWorkers.push(() => {
          finishStop?.();
          finishTask?.();
        });
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: vi.fn(() => stop),
          task: vi.fn(async () => {
            await task;
          }),
        };
      }
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => undefined),
        task: vi.fn(async () => {
          abort.abort();
        }),
      };
    });
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      stallThresholdMs: 30_000,
      isolatedIngress: {
        enabled: true,
        createWorker,
        drainIntervalMs: 500,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      const firstWatchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(31_000);
      firstWatchdog?.();
      await vi.waitFor(() => expectLogIncludes(log, "Isolated polling ingress stop timed out"));
      finishStoppedWorkers.shift()?.();
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));

      const secondWatchdog = await watchdogHarness.waitForWatchdogRegistration(2);
      watchdogHarness.setNow(62_000);
      secondWatchdog?.();
      await vi.waitFor(() => expectLogIncludes(log, "Stop timeout burst=2; applying cooldown."));
      finishStoppedWorkers.shift()?.();
      await runPromise;

      const stopCooldownCalls = computeBackoffMock.mock.calls.filter(
        ([policy]) => (policy as { initialMs: number }).initialMs === 120_000,
      );
      expect(stopCooldownCalls.map((call) => call[1])).toEqual([1]);
    } finally {
      watchdogHarness.restore();
      abort.abort();
    }
  });

  it("keeps isolated ingress alive when spooled messages show worker activity", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValue(bot);

    let onMessage: WorkerMessageListener | undefined;
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const workerStop = vi.fn(async () => {
      stopWorker?.();
    });
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((handler: WorkerMessageListener) => {
        onMessage = handler;
        return () => undefined;
      }),
      stop: workerStop,
      task: vi.fn(async () => {
        await workerDone;
      }),
    }));
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      stallThresholdMs: 30_000,
      isolatedIngress: {
        enabled: true,
        createWorker,
        drainIntervalMs: 500,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      onMessage?.({ type: "poll-start", offset: null, startedAt: 0 });
      watchdogHarness.setNow(31_000);
      onMessage?.({ type: "spooled", updateId: 42, queued: 1 });
      watchdogHarness.setNow(45_000);
      watchdog?.();

      expect(workerStop).not.toHaveBeenCalled();
      expectLogExcludes(log, "Polling stall detected");

      abort.abort();
      stopWorker?.();
      await runPromise;
    } finally {
      watchdogHarness.restore();
      abort.abort();
    }
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

  it("does not re-dispatch refetched updates after spooled completion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withTempSpool(async (tempDir) => {
        const abort = new AbortController();
        const events: number[] = [];
        await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "first delivery")]);

        const { runPromise, stopWorker } = startIsolatedIngressSession({
          abort,
          spoolDir: tempDir,
          drainIntervalMs: 10,
          handleUpdate: async (update) => {
            events.push(Number(update.update_id));
          },
        });

        await vi.waitFor(() => expect(events).toEqual([42]));
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

        await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "telegram refetch")]);
        await vi.advanceTimersByTimeAsync(50);

        expect(events).toEqual([42]);
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

        abort.abort();
        stopWorker();
        await runPromise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes active spooled claims while the handler is still running", async () => {
    const refreshHarness = installSpooledClaimRefreshHarness();
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseHandler: (() => void) | undefined;
      const handlerDone = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "long topic 10 turn")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          events.push(`topic10:${update.update_id}`);
          await handlerDone;
        },
      });

      try {
        await vi.waitFor(() => expect(events).toEqual(["topic10:42"]));
        const before = await claimedAtForUpdate(tempDir, 42);

        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        refreshHarness.triggerRefresh();
        await vi.waitFor(async () =>
          expect(await claimedAtForUpdate(tempDir, 42)).toBeGreaterThan(before),
        );

        releaseHandler?.();
        await vi.waitFor(async () =>
          expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
        );
      } finally {
        releaseHandler?.();
        abort.abort();
        stopWorker();
        refreshHarness.restore();
        await runPromise;
      }
    });
  });

  it("stops refreshing a claim when the drain loop is stalled", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const refreshHarness = installSpooledClaimRefreshHarness();
    await withTempSpool(async (tempDir) => {
      let blockedSecondClaim = false;
      let releaseSecondClaim: (() => void) | undefined;
      const secondClaimStarted = new Promise<void>((resolve) => {
        const gate = new Promise<void>((release) => {
          releaseSecondClaim = release;
        });
        setTelegramRuntime({
          state: {
            resolveStateDir: () => tempDir,
            openChannelIngressQueue: (
              options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
            ) => {
              const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
              return {
                ...queue,
                claimNext: async (...args: Parameters<typeof queue.claimNext>) => {
                  const claimOptions = args[0];
                  const blockedLaneKeys = claimOptions?.blockedLaneKeys
                    ? Array.from(claimOptions.blockedLaneKeys)
                    : [];
                  const candidateIds = claimOptions?.candidateIds
                    ? Array.from(claimOptions.candidateIds)
                    : [];
                  if (
                    candidateIds.includes("0000000000000043") &&
                    blockedLaneKeys.length > 0 &&
                    !blockedSecondClaim
                  ) {
                    blockedSecondClaim = true;
                    resolve();
                    await gate;
                  }
                  return queue.claimNext(...args);
                },
              };
            },
          },
        } as TelegramRuntime);
      });
      const abort = new AbortController();
      let releaseHandler: (() => void) | undefined;
      const handlerDone = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "first topic 10 turn"),
        topicUpdate(43, 11, "blocked topic 11 turn"),
      ]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async () => {
          await handlerDone;
        },
      });

      try {
        await secondClaimStarted;
        const before = await claimedAtForUpdate(tempDir, 42);
        vi.setSystemTime(1_000 + pollingSessionTesting.spooledClaimRefreshIntervalMs * 2 + 1);
        refreshHarness.triggerRefresh();
        await Promise.resolve();
        expect(await claimedAtForUpdate(tempDir, 42)).toBe(before);
      } finally {
        releaseSecondClaim?.();
        releaseHandler?.();
        abort.abort();
        stopWorker();
        refreshHarness.restore();
        vi.useRealTimers();
        await runPromise;
      }
    });
  });

  it("holds buffered spooled claims until deferred processing settles without blocking same-lane buffering", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "first buffered topic 10 turn"),
        topicUpdate(43, 10, "second buffered topic 10 turn"),
      ]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          events.push(`topic10:${update.update_id}`);
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-buffer:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["topic10:42", "topic10:43"]));
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([42, 43]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

      const completed: TelegramMessageProcessingResult = { kind: "completed" };
      for (const participant of participants) {
        participant.settle(completed);
      }
      await vi.waitFor(async () =>
        expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("refreshes deferred spooled claims after the active handler hands off", async () => {
    const refreshHarness = installSpooledClaimRefreshHarness();
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "buffered topic 10 turn")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-buffer:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
        },
      });

      try {
        await vi.waitFor(() => expect(participants).toHaveLength(1));
        const before = await claimedAtForUpdate(tempDir, 42);

        refreshHarness.triggerRefresh();
        await vi.waitFor(async () =>
          expect(await claimedAtForUpdate(tempDir, 42)).toBeGreaterThan(before),
        );

        participants[0]?.settle({ kind: "completed" });
        await vi.waitFor(async () =>
          expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
        );
      } finally {
        participants[0]?.settle({ kind: "completed" });
        abort.abort();
        stopWorker();
        refreshHarness.restore();
        await runPromise;
      }
    });
  });

  it("keeps a deferred claim owned while adopted completion retries", async () => {
    const refreshHarness = installSpooledClaimRefreshHarness();
    await withTempSpool(async (tempDir) => {
      let completeAttempts = 0;
      let refreshAttempts = 0;
      let failRefreshAfterAdoption = false;
      let releaseCompletion: (() => void) | undefined;
      let markCompletionRetryStarted: (() => void) | undefined;
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      const completionRetryStarted = new Promise<void>((resolve) => {
        markCompletionRetryStarted = resolve;
      });
      setTelegramRuntime({
        state: {
          resolveStateDir: () => tempDir,
          openChannelIngressQueue: (
            options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
          ) => {
            const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
            return {
              ...queue,
              refreshClaim: async (...args: Parameters<NonNullable<typeof queue.refreshClaim>>) => {
                refreshAttempts += 1;
                if (failRefreshAfterAdoption) {
                  return false;
                }
                return (await queue.refreshClaim?.(...args)) ?? false;
              },
              complete: async (...args: Parameters<typeof queue.complete>) => {
                completeAttempts += 1;
                if (completeAttempts === 1) {
                  throw new Error("transient completion write failure");
                }
                if (completeAttempts === 2) {
                  markCompletionRetryStarted?.();
                  await completionGate;
                }
                return await queue.complete(...args);
              },
            };
          },
        },
      } as TelegramRuntime);
      const abort = new AbortController();
      const log = vi.fn();
      const events: number[] = [];
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      const replyFenceKey = "test-completion-retry:topic-10";
      const replyFenceAbortController = new AbortController();
      beginTelegramReplyFence({
        key: replyFenceKey,
        laneKey: buildTelegramReplyFenceLaneKey({
          accountId: "default",
          sequentialKey: "telegram:-100:topic:10",
        }),
        supersede: false,
        abortController: replyFenceAbortController,
      });
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "buffered topic 10 turn")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        handleUpdate: async (update) => {
          events.push(Number(update.update_id));
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-completion-retry:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
        },
      });

      try {
        await vi.waitFor(() => expect(participants).toHaveLength(1));
        participants[0]?.settle({ kind: "completed" });
        await completionRetryStarted;

        expect(events).toEqual([42]);
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([42]);
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
        expectLogIncludes(log, "buffered completion retry 1 scheduled");

        failRefreshAfterAdoption = true;
        refreshHarness.triggerRefresh();
        await vi.waitFor(() => expect(refreshAttempts).toBe(1));
        expect(replyFenceAbortController.signal.aborted).toBe(false);

        releaseCompletion?.();
        await vi.waitFor(async () =>
          expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
        );
        await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "telegram refetch")]);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        expect(events).toEqual([42]);
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      } finally {
        releaseCompletion?.();
        abort.abort();
        stopWorker();
        endTelegramReplyFence(replyFenceKey, replyFenceAbortController);
        refreshHarness.restore();
        await runPromise;
      }
    });
  });

  it("releases buffered spooled claims for retry when deferred processing fails", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "buffered failure")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-buffer:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
        },
      });

      await vi.waitFor(() => expect(participants).toHaveLength(1));
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([42]),
      );

      abort.abort();
      participants[0]?.settle({
        kind: "failed-retryable",
        error: new Error("buffered dispatch failed"),
      });
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]));
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      expectLogIncludes(log, "spooled update 42 failed; keeping for retry");
      stopWorker();
      await runPromise;
    });
  });

  it("dead-letters buffered spooled claims when dispatch dedupe rollback fails", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      const events: string[] = [];
      let attempts = 0;
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "buffered rollback failure")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          attempts += 1;
          if (attempts === 1) {
            events.push(`dispatch:${update.update_id}`);
            const participant = createTelegramSpooledReplayDeferredParticipant(
              `test-buffer:${update.update_id}`,
            );
            if (!participant) {
              throw new Error("expected spooled replay participant");
            }
            participants.push(participant);
            return;
          }
          events.push(`duplicate-skip:${update.update_id}`);
        },
      });

      await vi.waitFor(() => expect(participants).toHaveLength(1));
      participants[0]?.settle({
        kind: "failed-retryable",
        error: new TelegramMessageDispatchReplayForgetError([{ key: "committed-dispatch-key" }]),
      });

      await vi.waitFor(async () => expect(await failedUpdateIds(tempDir)).toEqual([42]));
      expect(events).toEqual(["dispatch:42"]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      expectLogIncludes(log, "non-retryable dispatch-dedupe-rollback-failed");
      expectLogExcludes(log, "spooled update 42 failed; keeping for retry");

      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("fails buffered spooled claims instead of requeueing when deferred processing times out", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "buffered timeout")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        spooledUpdateHandlerTimeoutMs: 20,
        handleUpdate: async (update) => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-buffer:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
        },
      });

      await vi.waitFor(() => expect(participants).toHaveLength(1));
      await vi.waitFor(async () => expect(await failedUpdateIds(tempDir)).toEqual([42]));
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      expectLogIncludes(log, "pre-adoption timed out behind update 42");
      expectLogExcludes(log, "spooled update 42 failed; keeping for retry");
      expect(await failedUpdateReasons(tempDir)).toEqual([{ id: 42, reason: "handler-timeout" }]);
      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("keeps refreshing a buffered claim while timeout settlement waits for adoption", async () => {
    const refreshHarness = installSpooledClaimRefreshHarness();
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      let participant: TelegramSpooledReplayDeferredParticipant | undefined;
      let settlementHold: TelegramSpooledReplaySettlementHold | undefined;
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "held adoption")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        spooledUpdateHandlerTimeoutMs: 20,
        handleUpdate: async (update) => {
          const createdParticipant = createTelegramSpooledReplayDeferredParticipant(
            `test-held-adoption:${update.update_id}`,
          );
          if (!createdParticipant) {
            throw new Error("expected spooled replay participant");
          }
          participant = createdParticipant;
          settlementHold = createdParticipant.beginSettlementHold();
          if (!settlementHold) {
            throw new Error("expected spooled replay settlement hold");
          }
        },
      });

      try {
        await vi.waitFor(() => expect(participant).toBeDefined());
        const before = await claimedAtForUpdate(tempDir, 42);
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });

        expect(participant?.abortSignal.aborted).toBe(false);
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([42]);

        refreshHarness.triggerRefresh();
        await vi.waitFor(async () =>
          expect(await claimedAtForUpdate(tempDir, 42)).toBeGreaterThan(before),
        );

        settlementHold?.release("discard-pending");
        participant?.settle({ kind: "completed" });
        await vi.waitFor(async () =>
          expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
        );
        expect(await failedUpdateIds(tempDir)).toEqual([]);
        expectLogExcludes(log, "pre-adoption timed out behind update 42");
      } finally {
        settlementHold?.release("replay-pending");
        participant?.settle({ kind: "skipped" });
        abort.abort();
        stopWorker();
        refreshHarness.restore();
        await runPromise;
      }
    });
  });

  it("completes spooled row at adoption while a long turn is still settling (healthy long turn)", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "healthy long turn")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        spooledUpdateHandlerTimeoutMs: 80,
        handleUpdate: async (update) => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-adopt:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
          // Return immediately (deferred registered). Adoption settles the
          // spool row; the agent turn would continue under run lifecycle.
          queueMicrotask(() => {
            participant.settle({ kind: "completed" });
          });
        },
      });

      await vi.waitFor(() => expect(participants).toHaveLength(1));
      await vi.waitFor(async () =>
        expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await failedUpdateIds(tempDir)).toEqual([]);

      // Past the handler/adoption timeout after adoption: no dead-letter.
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(await failedUpdateIds(tempDir)).toEqual([]);
      expectLogExcludes(log, "timed out");
      expectLogExcludes(log, "handler-timeout");

      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("replays claimed spooled updates after a crash before adoption", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "pre-adoption crash")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-pre-crash:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
          // Never adopt: process dies with claim held.
        },
      });

      await vi.waitFor(() => expect(participants).toHaveLength(1));
      await vi.waitFor(async () =>
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map((c) => c.updateId),
        ).toEqual([42]),
      );

      abort.abort();
      stopWorker();
      await runPromise;

      // Stale-claim recovery after crash: row is still claimed → replayable.
      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir: tempDir,
        staleMs: 0,
      });
      expect(recovered).toBeGreaterThanOrEqual(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]);
      expect(await failedUpdateIds(tempDir)).toEqual([]);
    });
  });

  it("does not replay spooled updates after crash post-adoption (row already tombstoned)", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "post-adoption crash")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            `test-post-crash:${update.update_id}`,
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
          participants.push(participant);
          participant.settle({ kind: "completed" });
          // Turn would continue under run lifecycle; process crash after this is fine.
        },
      });

      await vi.waitFor(() => expect(participants).toHaveLength(1));
      await vi.waitFor(async () =>
        expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

      abort.abort();
      stopWorker();
      await runPromise;

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir: tempDir,
        staleMs: 0,
      });
      expect(recovered).toBe(0);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await failedUpdateIds(tempDir)).toEqual([]);
    });
  });

  it("records failed-retryable when dispatch throws before adoption", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "pre-adoption failure")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 500,
        handleUpdate: async (update) => {
          events.push(`throw:${update.update_id}`);
          throw new Error("session resolve failed before adoption");
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["throw:42"]));
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]));
      expect(await failedUpdateIds(tempDir)).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      expectLogIncludes(log, "spooled update 42 failed; keeping for retry");
      expectLogExcludes(log, "handler-timeout");

      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("drains a second same-lane update after the first turn is adopted", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "first long turn"),
        topicUpdate(43, 10, "second turn same lane"),
      ]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          events.push(`dispatch:${update.update_id}`);
          if (update.update_id === 42) {
            const participant = createTelegramSpooledReplayDeferredParticipant(
              `test-lane:${update.update_id}`,
            );
            if (!participant) {
              throw new Error("expected spooled replay participant");
            }
            participants.push(participant);
            // Adopt immediately so the lane frees while a long turn would
            // continue under run lifecycle (not retested here).
            participant.settle({ kind: "completed" });
          }
        },
      });

      await vi.waitFor(() => expect(events).toContain("dispatch:42"));
      await vi.waitFor(async () =>
        expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
      );
      // Lane free after adoption: second update reaches kernel dispatch.
      await vi.waitFor(() => expect(events).toEqual(["dispatch:42", "dispatch:43"]));
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("dead-letters missing harness failures so later same-lane updates can drain", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "missing harness turn"),
        topicUpdate(43, 11, "other topic turn"),
        topicUpdate(44, 10, "same topic after missing harness"),
      ]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          if (update.update_id === 42) {
            events.push("topic10:first");
            const err = new Error(
              'Requested agent harness "missing-harness-85470" is not registered.',
            );
            err.name = "MissingAgentHarnessError";
            throw err;
          }
          if (update.update_id === 43) {
            events.push("topic11");
            return;
          }
          if (update.update_id === 44) {
            events.push("topic10:second");
            abort.abort();
          }
        },
      });

      await vi.waitFor(() =>
        expect(events).toEqual(["topic10:first", "topic11", "topic10:second"]),
      );
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));
      expect(await failedUpdateIds(tempDir)).toEqual([42]);
      expectLogIncludes(log, "spooled update 42 failed with non-retryable missing-agent-harness");
      expectLogIncludes(log, "dead-lettered");
      expectLogExcludes(log, "spooled update 42 failed; keeping for retry");
      stopWorker();
      await runPromise;
    });
  });

  it("dead-letters retryable poison updates after bounded retries so the lane can drain", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withTempSpool(async (tempDir) => {
        const abort = new AbortController();
        const log = vi.fn();
        const events: string[] = [];
        let poisonAttempts = 0;
        await writeSpooledTestUpdates(
          tempDir,
          [topicUpdate(42, 10, "poison"), topicUpdate(44, 10, "after poison")],
          {
            now: Date.now() - pollingSessionTesting.spooledRetryDeadLetterMinAgeMs,
          },
        );

        const { runPromise, stopWorker } = startIsolatedIngressSession({
          abort,
          spoolDir: tempDir,
          log,
          drainIntervalMs: 100,
          handleUpdate: async (update) => {
            if (update.update_id === 42) {
              poisonAttempts += 1;
              events.push(`poison:${poisonAttempts}`);
              throw new Error("deterministic handler failure");
            }
            if (update.update_id === 44) {
              events.push("after-poison");
              abort.abort();
            }
          },
        });

        await vi.waitFor(() => expect(poisonAttempts).toBe(1));
        await vi.advanceTimersByTimeAsync(130_000);

        await vi.waitFor(() => expect(events.at(-1)).toBe("after-poison"));
        expect(poisonAttempts).toBe(pollingSessionTesting.spooledRetryMaxAttempts);
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
        expect(await failedUpdateReasons(tempDir)).toEqual([
          { id: 42, reason: "retry-limit-exceeded" },
        ]);
        expectLogIncludes(log, "spooled update 42 on lane");
        expectLogIncludes(log, "reached retry limit after 8 attempts; dead-lettered");

        stopWorker();
        await runPromise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  for (const scenario of [
    {
      name: "topic",
      conflict: topicUpdate(42, 10, "retryable session init conflict"),
      blocked: topicUpdate(43, 10, "same topic must wait behind retry backoff"),
      other: topicUpdate(44, 11, "other topic can continue"),
      conflictEvent: "topic10:conflict",
      blockedEvent: "topic10:overtook",
      otherEvent: "topic11",
      error: "reply session initialization conflicted for agent:main:telegram:group:-100:topic:10",
    },
    {
      name: "direct message",
      conflict: directUpdate(42, 100, "retryable session init conflict"),
      blocked: directUpdate(43, 100, "same DM must wait behind retry backoff"),
      other: directUpdate(44, 101, "other DM can continue"),
      conflictEvent: "dm100:conflict",
      blockedEvent: "dm100:overtook",
      otherEvent: "dm101",
      error: "reply session initialization conflicted for agent:main:telegram:direct:100",
    },
  ]) {
    it(`backs off retryable reply session init conflicts for ${scenario.name} lanes`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await withTempSpool(async (tempDir) => {
          const abort = new AbortController();
          const log = vi.fn();
          let attempts = 0;
          const events: string[] = [];
          await writeSpooledTestUpdates(tempDir, [
            scenario.conflict,
            scenario.blocked,
            scenario.other,
          ]);

          const { runPromise, stopWorker } = startIsolatedIngressSession({
            abort,
            spoolDir: tempDir,
            log,
            drainIntervalMs: 100,
            handleUpdate: async (update) => {
              if (update.update_id === scenario.conflict.update_id) {
                attempts += 1;
                events.push(`${scenario.conflictEvent}:${attempts}`);
                throw new Error(scenario.error);
              }
              if (update.update_id === scenario.blocked.update_id) {
                events.push(scenario.blockedEvent);
                return;
              }
              if (update.update_id === scenario.other.update_id) {
                events.push(scenario.otherEvent);
              }
            },
          });

          await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1));
          await vi.waitFor(() => expect(events).toContain(scenario.otherEvent));
          expect(events).not.toContain(scenario.blockedEvent);
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([
            scenario.conflict.update_id,
            scenario.blocked.update_id,
          ]);
          expect(await failedUpdateIds(tempDir)).toEqual([]);

          await vi.advanceTimersByTimeAsync(1_200);
          await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
          expect(events).not.toContain(scenario.blockedEvent);
          expectLogIncludes(
            log,
            `spooled update ${scenario.conflict.update_id} failed; keeping for retry`,
          );

          abort.abort();
          stopWorker();
          await runPromise;
        });
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("dead-letters wrapped missing harness failures", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "wrapped missing harness")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        handleUpdate: async () => {
          const cause = new Error(
            'Requested agent harness "missing-harness-85470" is not registered.',
          );
          const err = new Error("Agent turn failed", { cause });
          throw err;
        },
      });

      await vi.waitFor(async () => expect(await failedUpdateIds(tempDir)).toEqual([42]));
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expectLogIncludes(log, "spooled update 42 failed with non-retryable missing-agent-harness");
      expectLogExcludes(log, "spooled update 42 failed; keeping for retry");
      abort.abort();
      stopWorker();
      await runPromise;
    });
  });

  it("dead-letters grammY BotError-wrapped missing harness failures", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "bot error wrapped missing harness"),
      ]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        handleUpdate: async () => {
          const cause = new Error(
            'Requested agent harness "missing-harness-85470" is not registered.',
          );
          const middlewareError = new Error("Agent turn failed", { cause });
          const botError = Object.assign(new Error("Error in middleware: Agent turn failed"), {
            name: "BotError",
            error: middlewareError,
          });
          throw botError;
        },
      });

      await vi.waitFor(async () => expect(await failedUpdateIds(tempDir)).toEqual([42]));
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expectLogIncludes(log, "spooled update 42 failed with non-retryable missing-agent-harness");
      expectLogExcludes(log, "spooled update 42 failed; keeping for retry");
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
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
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
      const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        ownerId: `${liveOwnerPid}:other-process`,
        claimedAt: Date.now(),
      });

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir: tempDir,
        staleMs: 0,
        shouldRecover: (claim) => !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim),
      });

      expect(recovered).toBe(0);
      expect(await pendingUpdateIds(tempDir)).toEqual([43]);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
          (claim) => claim.updateId,
        ),
      ).toEqual([42]);
    });
  });

  it("releases pid-reused claims before draining later same-lane updates", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "wedged topic 10 turn"),
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
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        ownerId: `${process.pid}:other-process`,
        claimedAt: Date.now() - 101,
      });

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        spooledUpdateHandlerTimeoutMs: 100,
        handleUpdate: async (update) => {
          events.push(`handled:${update.update_id}`);
          abort.abort();
        },
      });

      await vi.waitFor(() => expect(events).toEqual(["handled:42"]));
      await runPromise;
      expect(await failedUpdateReasons(tempDir)).toEqual([]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([43]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      stopWorker();
    });
  });

  it("reclaims an expired foreign claim so the lane can drain", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: number[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "expired foreign claim"),
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
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        ownerId: "1:other-process",
        claimedAt: Date.now() - telegramSpooledUpdateClaimLeaseMs - 1,
      });

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        spooledUpdateHandlerTimeoutMs: 100,
        handleUpdate: async (update) => {
          events.push(update.update_id ?? -1);
          if (events.length === 2) {
            abort.abort();
          }
        },
      });

      await vi.waitFor(() => expect(events).toEqual([42, 43]));
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

  it("recovers a lone active spooled handler owned by a replaced session (#84158)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    let releaseTurn: (() => void) | undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      await turnDone;
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
    await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "lone active topic turn")]);
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
        log,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
          spooledUpdateHandlerTimeoutMs: 100,
          spooledUpdateHandlerAbortGraceMs: 100,
        },
      });
      const firstRunPromise = firstSession.runUntilAbort();
      await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      firstAbort.abort();
      await vi.advanceTimersByTimeAsync(16_000);
      await firstRunPromise;

      const secondSession = createPollingSession({
        abortSignal: secondAbort.signal,
        log,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
          spooledUpdateHandlerTimeoutMs: 100,
          spooledUpdateHandlerAbortGraceMs: 100,
        },
      });
      const secondRunPromise = secondSession.runUntilAbort();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () => expect(await failedUpdateIds(tempDir)).toEqual([42]));
      await vi.waitFor(() =>
        expect(
          log.mock.calls.some(([line]) =>
            String(line).includes("timed out spooled update 42 did not stop"),
          ),
        ).toBe(true),
      );
      expect(handleUpdate).toHaveBeenCalledTimes(1);

      secondAbort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await secondRunPromise;
    } finally {
      releaseTurn?.();
      firstAbort.abort();
      secondAbort.abort();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn(() => () => undefined),
      stop: vi.fn(async () => undefined),
      task: vi.fn(async () => {
        workerTaskCalls += 1;
        if (workerTaskCalls === 1) {
          return;
        }
        await new Promise<void>((resolve) => {
          abort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
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

  it("restarts isolated ingress when the worker task rejects before shutdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }));

    let workerTaskCalls = 0;
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
          workerTaskCalls += 1;
          if (workerTaskCalls === 1) {
            throw new Error("worker crashed");
          }
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
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      const firstFetchSignal = mockObjectArg(
        createTelegramBotMock,
        "first createTelegramBot",
        0,
      ).fetchAbortSignal;
      const firstMediaSignal = mockObjectArg(
        createTelegramBotMock,
        "first createTelegramBot",
        0,
      ).mediaAbortSignal;
      const secondFetchSignal = mockObjectArg(
        createTelegramBotMock,
        "second createTelegramBot",
        1,
      ).fetchAbortSignal;
      const secondMediaSignal = mockObjectArg(
        createTelegramBotMock,
        "second createTelegramBot",
        1,
      ).mediaAbortSignal;
      expect(firstFetchSignal).toBeInstanceOf(AbortSignal);
      expect(firstMediaSignal).toBeInstanceOf(AbortSignal);
      expect(secondFetchSignal).toBeInstanceOf(AbortSignal);
      expect(secondMediaSignal).toBeInstanceOf(AbortSignal);
      expect((firstFetchSignal as AbortSignal).aborted).toBe(false);
      expect((firstMediaSignal as AbortSignal).aborted).toBe(true);
      expect((secondFetchSignal as AbortSignal).aborted).toBe(false);
      expect((secondMediaSignal as AbortSignal).aborted).toBe(false);
      expectLogIncludes(log, "isolated polling ingress failed: worker crashed");
      expect(
        statusPatches(setStatus).some(
          (patch) => patch.connected === false && patch.lastError === "worker crashed",
        ),
      ).toBe(true);

      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
      expect((firstFetchSignal as AbortSignal).aborted).toBe(true);
      expect((secondFetchSignal as AbortSignal).aborted).toBe(true);
      expect((secondMediaSignal as AbortSignal).aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for a fresh bot before draining updates after an isolated worker crash", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseBackoff: (() => void) | undefined;
    const backoff = new Promise<void>((resolve) => {
      releaseBackoff = resolve;
    });
    sleepWithAbortMock.mockImplementationOnce(async () => {
      await backoff;
      return undefined;
    });

    let firstMediaSignal: AbortSignal | undefined;
    let rejectFirstWorker: ((err: Error) => void) | undefined;
    const firstWorkerDone = new Promise<void>((_resolve, reject) => {
      rejectFirstWorker = reject;
    });
    const firstHandleUpdate = vi.fn(async () => {
      rejectFirstWorker?.(new Error("worker crashed"));
      if (!firstMediaSignal) {
        throw new Error("Expected the first polling cycle signal");
      }
      await waitForAbortSignal(firstMediaSignal);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const secondHandleUpdate = vi.fn(async () => undefined);
    const createBot = (handleUpdate: (update: { update_id?: number }) => Promise<unknown>) => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    });
    createTelegramBotMock
      .mockImplementationOnce((opts: { mediaAbortSignal?: AbortSignal }) => {
        firstMediaSignal = opts.mediaAbortSignal;
        return createBot(firstHandleUpdate);
      })
      .mockReturnValueOnce(createBot(secondHandleUpdate));

    let workerIndex = 0;
    let stopSecondWorker: (() => void) | undefined;
    const secondWorkerDone = new Promise<void>((resolve) => {
      stopSecondWorker = resolve;
    });
    const createWorker = vi.fn(() => {
      workerIndex += 1;
      if (workerIndex === 1) {
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: vi.fn(async () => undefined),
          task: vi.fn(async () => await firstWorkerDone),
        };
      }
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => {
          stopSecondWorker?.();
        }),
        task: vi.fn(async () => await secondWorkerDone),
      };
    });

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
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));

      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "crash the old bot"),
        topicUpdate(43, 11, "wait for the fresh bot"),
      ]);
      await vi.advanceTimersByTimeAsync(50);
      await vi.waitFor(() => expect(firstHandleUpdate).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(sleepWithAbortMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(firstHandleUpdate).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => {
        const unstarted = (
          await listTelegramSpooledUpdates({ spoolDir: tempDir, limit: "all" })
        ).find((update) => update.updateId === 43);
        expect(unstarted).toMatchObject({ attempts: 0 });
        expect(unstarted?.lastAttemptAt).toBeUndefined();
        expect(unstarted?.lastError).toBeUndefined();
      });

      releaseBackoff?.();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(secondHandleUpdate).toHaveBeenCalledTimes(2));
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;

      expect(createWorker).toHaveBeenCalledTimes(2);
      expect(firstHandleUpdate).toHaveBeenCalledTimes(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
    } finally {
      releaseBackoff?.();
      abort.abort();
      stopSecondWorker?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps adopted-turn Bot API delivery alive when an isolated worker crashes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseBackoff: (() => void) | undefined;
    const backoff = new Promise<void>((resolve) => {
      releaseBackoff = resolve;
    });
    sleepWithAbortMock.mockImplementationOnce(async () => {
      await backoff;
      return undefined;
    });

    let adopted: (() => void) | undefined;
    const adoptedTurn = new Promise<void>((resolve) => {
      adopted = resolve;
    });
    let deliveryResolve: (() => void) | undefined;
    let deliveryReject: ((err: unknown) => void) | undefined;
    const delivery = new Promise<void>((resolve, reject) => {
      deliveryResolve = resolve;
      deliveryReject = reject;
    });
    let firstFetchSignal: AbortSignal | undefined;
    let firstMediaSignal: AbortSignal | undefined;
    const sendMessage = vi.fn(async () => {
      if (firstFetchSignal?.aborted) {
        throw new Error("adopted-turn Bot API client was aborted");
      }
    });
    createTelegramBotMock.mockImplementationOnce(
      (opts: { fetchAbortSignal?: AbortSignal; mediaAbortSignal?: AbortSignal }) => {
        firstFetchSignal = opts.fetchAbortSignal;
        firstMediaSignal = opts.mediaAbortSignal;
        const api = {
          deleteWebhook: vi.fn(async () => true),
          sendMessage,
          config: { use: vi.fn() },
        };
        return {
          api,
          init: vi.fn(async () => undefined),
          handleUpdate: vi.fn(async (update: { update_id?: number }) => {
            const participant = createTelegramSpooledReplayDeferredParticipant(
              `test-adopted-delivery:${update.update_id}`,
            );
            if (!participant || !firstMediaSignal) {
              throw new Error("Expected a spooled participant and media signal");
            }
            participant.settle({ kind: "completed" });
            adopted?.();
            void (async () => {
              try {
                await waitForAbortSignal(firstMediaSignal);
                // Streaming, edits, and native-quote fallbacks retain this adopted bot client.
                await api.sendMessage();
                deliveryResolve?.();
              } catch (err) {
                deliveryReject?.(err);
              }
            })();
          }),
          stop: vi.fn(async () => undefined),
        };
      },
    );

    const createWorker = vi.fn(() => ({
      onMessage: vi.fn(() => () => undefined),
      stop: vi.fn(async () => undefined),
      task: vi.fn(async () => {
        await adoptedTurn;
        throw new Error("worker crashed after turn adoption");
      }),
    }));

    try {
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "finish after worker crash")]);
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

      await delivery;
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(firstMediaSignal?.aborted).toBe(true);
      expect(firstFetchSignal?.aborted).toBe(false);
      await vi.waitFor(async () => expect(await pendingUpdateIds(tempDir, "all")).toEqual([]));

      abort.abort();
      releaseBackoff?.();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
      expect(firstFetchSignal?.aborted).toBe(true);
    } finally {
      releaseBackoff?.();
      abort.abort();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats isolated ingress worker rejection after abort as clean shutdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }));

    let rejectWorker: ((err: Error) => void) | undefined;
    const workerDone = new Promise<void>((_resolve, reject) => {
      rejectWorker = reject;
    });
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn(() => () => undefined),
      stop: vi.fn(async () => {
        rejectWorker?.(new Error("worker exited with code 1"));
      }),
      task: vi.fn(async () => {
        await workerDone;
      }),
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;

      expect(createWorker).toHaveBeenCalledTimes(1);
      expectLogExcludes(log, "isolated polling ingress failed");
    } finally {
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates fatal isolated ingress polling errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }));

    let listener: WorkerPollErrorListener | undefined;
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((next: WorkerPollErrorListener) => {
        listener = next;
        return () => undefined;
      }),
      stop: vi.fn(async () => undefined),
      task: vi.fn(async () => {
        listener?.({
          type: "poll-error",
          message: "Unauthorized",
          finishedAt: Date.now(),
        });
        throw new Error("Telegram ingress worker exited with code 1");
      }),
    }));

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

      await expect(session.runUntilAbort()).rejects.toThrow("Unauthorized");

      expect(createWorker).toHaveBeenCalledTimes(1);
      expectLogExcludes(log, "isolated polling ingress failed");
      expect(
        statusPatches(setStatus).some(
          (patch) => patch.connected === false && patch.lastError === "Unauthorized",
        ),
      ).toBe(true);
    } finally {
      abort.abort();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restarts isolated ingress on a getUpdates conflict instead of crashing the account", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    // 409 conflicts are not "recoverable network errors"; the conflict branch
    // must restart the cycle before that classifier is consulted.
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);
    const deleteWebhook = vi.fn(async () => true);
    createTelegramBotMock.mockImplementation(() => ({
      api: {
        deleteWebhook,
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }));
    const transport1 = makeTelegramTransport();
    const transport2 = makeTelegramTransport();
    const createTelegramTransport = vi
      .fn<() => ReturnType<typeof makeTelegramTransport>>()
      .mockReturnValueOnce(transport2);

    let workerCycle = 0;
    let listener: WorkerPollErrorListener | undefined;
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((next: WorkerPollErrorListener) => {
        listener = next;
        return () => undefined;
      }),
      stop: vi.fn(async () => undefined),
      task: vi.fn(async () => {
        workerCycle += 1;
        if (workerCycle === 1) {
          listener?.({
            type: "poll-error",
            message: "Conflict: terminated by other getUpdates request",
            errorCode: 409,
            finishedAt: Date.now(),
          });
          throw new Error("Telegram ingress worker exited with code 1");
        }
        abort.abort();
      }),
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        setStatus,
        telegramTransport: transport1,
        createTelegramTransport,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      await session.runUntilAbort();

      expect(createWorker).toHaveBeenCalledTimes(2);
      // The conflict resets webhook cleanup so the next cycle re-runs deleteWebhook.
      expect(deleteWebhook).toHaveBeenCalledTimes(2);
      // The conflict marks the transport dirty so the next cycle gets a fresh socket.
      expect(createTelegramTransport).toHaveBeenCalledTimes(1);
      expectLogIncludes(log, "Another OpenClaw gateway, script, or Telegram poller");
      expect(
        statusPatches(setStatus).some(
          (patch) =>
            patch.connected === false &&
            String(patch.lastError).includes("Another OpenClaw gateway"),
        ),
      ).toBe(true);
    } finally {
      abort.abort();
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

  it("fails a timed-out spooled handler and restarts before draining later same-lane updates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const ignoredSetStatus = vi.fn();
    void ignoredSetStatus;
    const events: string[] = [];
    const firstBot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`first:${update.update_id}`);
        await waitForTestReplyFenceAbort({
          key: "test-session:topic-10",
          laneKey: "telegram:-100:topic:10",
        });
      }),
      stop: vi.fn(async () => undefined),
    };
    const secondBot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`second:${update.update_id}`);
        abort.abort();
      }),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(firstBot).mockReturnValueOnce(secondBot);
    await writeSpooledTestUpdates(tempDir, [
      topicUpdate(42, 10, "wedged topic 10 turn"),
      topicUpdate(43, 10, "later topic 10 turn"),
    ]);

    const worker = createIdleIngressWorker();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      isolatedIngress: {
        enabled: true,
        spoolDir: tempDir,
        createWorker: worker.createWorker,
        drainIntervalMs: 10,
        spooledUpdateHandlerTimeoutMs: 100,
        spooledUpdateHandlerAbortGraceMs: 100,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(events).toEqual(["first:42"]));

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(worker.createWorker).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(events).toEqual(["first:42", "second:43"]));
      await runPromise;

      expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
      expect(firstBot.stop).toHaveBeenCalledTimes(1);
      expect(secondBot.stop).toHaveBeenCalledTimes(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await failedUpdateIds(tempDir)).toEqual([42]);
      expectLogIncludes(log, "spool handler timed out behind update 42");
    } finally {
      abort.abort();
      worker.stop();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a timed-out lane guarded until the old handler stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const events: string[] = [];
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnDone = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    createTelegramBotMock.mockReturnValueOnce({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`first:${update.update_id}`);
        await firstTurnDone;
      }),
      stop: vi.fn(async () => undefined),
    });
    await writeSpooledTestUpdates(tempDir, [
      topicUpdate(42, 10, "wedged topic 10 turn"),
      topicUpdate(43, 10, "later topic 10 turn"),
    ]);

    const worker = createIdleIngressWorker();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      isolatedIngress: {
        enabled: true,
        spoolDir: tempDir,
        createWorker: worker.createWorker,
        drainIntervalMs: 10,
        spooledUpdateHandlerTimeoutMs: 100,
        spooledUpdateHandlerAbortGraceMs: 100,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(events).toEqual(["first:42"]));

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expectLogIncludes(log, "did not stop within 100ms"));
      await vi.advanceTimersByTimeAsync(500);

      expect(worker.createWorker).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["first:42"]);
      expect(await failedUpdateIds(tempDir)).toEqual([42]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([43]);

      releaseFirstTurn?.();
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
    } finally {
      releaseFirstTurn?.();
      abort.abort();
      worker.stop();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps oversized spooled update handler abort grace timers", async () => {
    expect(
      pollingSessionTesting.resolveSpooledUpdateHandlerAbortGraceMs(Number.MAX_SAFE_INTEGER),
    ).toBe(MAX_TIMER_TIMEOUT_MS);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseTurn: (() => void) | undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    try {
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "wedged topic 10 turn"),
        topicUpdate(43, 10, "blocked topic 10 turn"),
      ]);
      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        spooledUpdateHandlerTimeoutMs: 100,
        spooledUpdateHandlerAbortGraceMs: Number.MAX_SAFE_INTEGER,
        handleUpdate: async () => {
          await turnDone;
        },
      });

      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => {
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      });

      releaseTurn?.();
      abort.abort();
      stopWorker();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
    } finally {
      releaseTurn?.();
      abort.abort();
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not drain more updates on the old bot while a timeout restart is pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const events: string[] = [];
    const firstBot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`first:${update.update_id}`);
        await waitForTestReplyFenceAbort({
          key: "test-session:topic-10",
          laneKey: "telegram:-100:topic:10",
        });
      }),
      stop: vi.fn(async () => undefined),
    };
    const secondBot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`second:${update.update_id}`);
        abort.abort();
      }),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValueOnce(firstBot).mockReturnValueOnce(secondBot);
    await writeSpooledTestUpdates(tempDir, [
      topicUpdate(42, 10, "wedged topic 10 turn"),
      topicUpdate(43, 10, "later topic 10 turn"),
    ]);

    let releaseFirstWorker: (() => void) | undefined;
    const firstWorkerDone = new Promise<void>((resolve) => {
      releaseFirstWorker = resolve;
    });
    let releaseSecondWorker: (() => void) | undefined;
    const secondWorkerDone = new Promise<void>((resolve) => {
      releaseSecondWorker = resolve;
    });
    const firstWorkerStop = vi.fn(async () => undefined);
    let workerIndex = 0;
    const createWorker = vi.fn(() => {
      workerIndex += 1;
      if (workerIndex === 1) {
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: firstWorkerStop,
          task: vi.fn(async () => {
            await firstWorkerDone;
          }),
        };
      }
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => {
          releaseSecondWorker?.();
        }),
        task: vi.fn(async () => {
          await secondWorkerDone;
        }),
      };
    });

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 10,
          spooledUpdateHandlerTimeoutMs: 100,
          spooledUpdateHandlerAbortGraceMs: 100,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(events).toEqual(["first:42"]));
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => expect(firstWorkerStop).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(500);
      expect(events).toEqual(["first:42"]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([43]);

      releaseFirstWorker?.();
      await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(events).toEqual(["first:42", "second:43"]));
      await runPromise;
    } finally {
      abort.abort();
      releaseFirstWorker?.();
      releaseSecondWorker?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a timed-out lane guarded when its failed state cannot be written", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    const events: string[] = [];
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const spoolModule = await import("./telegram-ingress-spool.js");
    const failSpy = vi
      .spyOn(spoolModule, "failTelegramSpooledUpdateClaim")
      .mockRejectedValueOnce(new Error("disk full"));
    createTelegramBotMock.mockReturnValueOnce({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`handled:${update.update_id}`);
        await regularTurnDone;
      }),
      stop: vi.fn(async () => undefined),
    });
    await writeSpooledTestUpdates(tempDir, [
      topicUpdate(42, 10, "wedged topic 10 turn"),
      topicUpdate(43, 10, "later topic 10 turn"),
    ]);
    const workerListeners: WorkerPollSuccessListener[] = [];
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const createWorker = vi.fn(() => ({
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
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        setStatus,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 10,
          spooledUpdateHandlerTimeoutMs: 100,
        },
      });

      const runPromise = session.runUntilAbort();
      await vi.waitFor(() => expect(events).toEqual(["handled:42"]));
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => expectLogIncludes(log, "could not be marked failed: disk full"));

      await vi.advanceTimersByTimeAsync(500);
      expect(createWorker).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["handled:42"]);
      expect(await failedUpdateIds(tempDir)).toEqual([]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([43]);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
          (claim) => claim.updateId,
        ),
      ).toEqual([42]);
      workerListeners[0]?.({
        type: "poll-success",
        offset: null,
        count: 0,
        finishedAt: Date.now(),
      });
      expect(statusPatches(setStatus).at(-1)?.connected).toBe(false);
      expect(String(statusPatches(setStatus).at(-1)?.lastError)).toContain(
        "isolated polling spool handler timed out",
      );

      releaseRegularTurn?.();
      abort.abort();
      stopWorker?.();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
    } finally {
      failSpy.mockRestore();
      releaseRegularTurn?.();
      abort.abort();
      stopWorker?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks isolated ingress unhealthy when a spooled backlog stalls before handler timeout", async () => {
    vi.useFakeTimers({ now: 1_000, shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const setStatus = vi.fn();
    let releaseRegularTurn: (() => void) | undefined;
    const regularTurnDone = new Promise<void>((resolve) => {
      releaseRegularTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      await regularTurnDone;
    });
    createTelegramBotMock.mockReturnValueOnce({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    });
    await writeSpooledTestUpdates(tempDir, [
      topicUpdate(42, 10, "active topic 10 turn"),
      topicUpdate(43, 10, "later topic 10 turn"),
    ]);

    const workerListeners: WorkerMessageListener[] = [];
    let stopWorker: (() => void) | undefined;
    const workerDone = new Promise<void>((resolve) => {
      stopWorker = resolve;
    });
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((listener: WorkerMessageListener) => {
        workerListeners.push(listener);
        return () => undefined;
      }),
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
        setStatus,
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: pollingSessionTesting.isolatedIngressBacklogStallMs * 2,
          spooledUpdateHandlerTimeoutMs: pollingSessionTesting.isolatedIngressBacklogStallMs * 2,
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

      vi.setSystemTime(1_000 + pollingSessionTesting.isolatedIngressBacklogStallMs + 1);
      workerListeners[0]?.({ type: "spooled", updateId: 43, queued: 1 });
      await vi.waitFor(() =>
        expect(
          statusPatches(setStatus).some(
            (patch) =>
              patch.connected === false &&
              String(patch.lastError).includes("isolated polling spool backlog stalled"),
          ),
        ).toBe(true),
      );
      expect(await failedUpdateIds(tempDir)).toEqual([]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([43]);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
          (claim) => claim.updateId,
        ),
      ).toEqual([42]);

      releaseRegularTurn?.();
      abort.abort();
      stopWorker?.();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;
    } finally {
      releaseRegularTurn?.();
      abort.abort();
      stopWorker?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks isolated ingress unhealthy when a spooled backlog handler times out", async () => {
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
      await Promise.race([
        regularTurnDone,
        waitForTestReplyFenceAbort({
          key: "test-status-session:dm",
          laneKey: "telegram:123",
        }),
      ]);
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
          spooledUpdateHandlerTimeoutMs: 100,
          spooledUpdateHandlerAbortGraceMs: 100,
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

      await vi.advanceTimersByTimeAsync(250);

      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("isolated polling spool handler timed out"),
        ),
      );
      expect(
        statusPatches(setStatus).some(
          (patch) =>
            patch.connected === false &&
            String(patch.lastError).includes("isolated polling spool handler timed out"),
        ),
      ).toBe(true);
      // 42 (the backlog handler) recovers first; after the restart 43 becomes a
      // lone active handler on the same lane, hangs the same way, and is now also
      // recovered on timeout rather than stranded with no backlog behind it (#84158).
      // Each recovery restarts ingress, so the worker is created once more per
      // recovered handler (initial + two restarts).
      await vi.waitFor(async () => expect(await failedUpdateIds(tempDir)).toEqual([42, 43]));
      expect(createWorker).toHaveBeenCalledTimes(3);

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
    const secondBotStop = vi.fn(async () => undefined);
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
    createTelegramBotMock.mockReturnValueOnce(bot).mockReturnValueOnce({
      ...bot,
      stop: secondBotStop,
    });

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
      expect(botStop).toHaveBeenCalledTimes(1);
      expectLogIncludes(log, "Polling stall detected");
      expectLogIncludes(log, "polling stall detected");
      expectLogExcludes(log, "Polling runner stop timed out");
    } finally {
      watchdogHarness.restore();
    }
  });

  it("cools down repeated stop-timeout restart bursts", () => {
    computeBackoffMock.mockImplementation((policy: { initialMs: number }, attempt: number) => {
      if (policy.initialMs === 120_000) {
        return attempt * 100_000;
      }
      return attempt * 1_000;
    });

    const state = pollingSessionTesting.createTelegramRestartBackoffState();
    expect(
      pollingSessionTesting.resolveTelegramRestartDelayMs(state, { stopTimedOut: true }),
    ).toEqual({ delayMs: 1_000, stopTimeoutSuffix: "" });
    expect(
      pollingSessionTesting.resolveTelegramRestartDelayMs(state, { stopTimedOut: true }),
    ).toEqual({
      delayMs: 100_000,
      stopTimeoutSuffix: " Stop timeout burst=2; applying cooldown.",
    });
    expect(
      pollingSessionTesting.resolveTelegramRestartDelayMs(state, { stopTimedOut: true }),
    ).toEqual({
      delayMs: 200_000,
      stopTimeoutSuffix: " Stop timeout burst=3; applying cooldown.",
    });

    const stopCooldownCalls = computeBackoffMock.mock.calls.filter(
      ([policy]) => (policy as { initialMs: number }).initialMs === 120_000,
    );
    expect(stopCooldownCalls.map((call) => call[1])).toEqual([1, 2]);
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

  it("throttles healthy delivery drains and re-arms after polling errors", async () => {
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

    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1));
    await apiMiddleware(
      vi.fn(async () => []),
      "getUpdates",
      { offset: 3 },
    );
    await vi.waitFor(() => expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1));
    await expect(
      apiMiddleware(
        vi.fn(async () => {
          throw new Error("offline");
        }),
        "getUpdates",
        { offset: 4 },
      ),
    ).rejects.toThrow("offline");
    await apiMiddleware(
      vi.fn(async () => []),
      "getUpdates",
      { offset: 5 },
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
    const setStatus = vi.fn();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      setStatus,
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

      // The stall must reach channel status, not just the gateway log.
      expect(
        statusPatches(setStatus).some(
          (patch) =>
            patch.connected === false && String(patch.lastError).includes("Polling stall detected"),
        ),
      ).toBe(true);
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
    const setStatus = vi.fn();
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
      setStatus,
    });

    await session.runUntilAbort();

    expectLogIncludes(log, "Another OpenClaw gateway, script, or Telegram poller");
    // The hint must reach channel status, not just the gateway log.
    expect(
      statusPatches(setStatus).some(
        (patch) =>
          patch.connected === false && String(patch.lastError).includes("Another OpenClaw gateway"),
      ),
    ).toBe(true);
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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
