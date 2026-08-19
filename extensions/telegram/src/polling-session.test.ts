import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS as TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  isIngressClaimOwnedByOtherLiveProcess as isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
  resolveIngressRetryDelayMs,
  shouldDeadLetterRetryableIngressEvent,
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitTelegramMessageDispatchReplay } from "./message-dispatch-dedupe.js";
import {
  createTelegramRestartBackoffState,
  resetTelegramRestartBackoffState,
  resolveTelegramRestartDelayMs,
} from "./polling-session-restart-policy.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramPollingSessionStateForTest,
  resetTelegramReplyFenceForTest as resetTelegramReplyFenceForTests,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { createTelegramUpdateOffsetPersistence } from "./update-offset-persistence.js";
const resolveSpooledUpdateRetryDelayMs = (
  update: { attempts?: number; lastAttemptAt?: number; lastError?: string; receivedAt: number },
  now?: number,
) => resolveIngressRetryDelayMs(update, undefined, now);
const shouldDeadLetterRetryableSpooledUpdate = (
  update: { receivedAt: number },
  attempt: number,
  now?: number,
) => shouldDeadLetterRetryableIngressEvent(update, attempt, undefined, now);
import type { TelegramSpooledUpdate } from "./telegram-ingress-spool.test-support.js";
import {
  TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER,
  type TelegramIngressWorkerMessage,
} from "./telegram-ingress-worker.js";

async function waitForTelegramTestState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return await vi.waitFor(assertion, { interval: 1 });
}

const runMock = vi.hoisted(() => vi.fn());
const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const isTelegramAuthenticationErrorMock = vi.hoisted(() => vi.fn(() => false));
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
  isTelegramAuthenticationError: isTelegramAuthenticationErrorMock,
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
const telegramSpooledRetryDeadLetterMinAgeMs = 24 * 60 * 60 * 1000;
const pollingSessionTesting = {
  createTelegramRestartBackoffState,
  isolatedIngressBacklogStallMs: 25 * 60_000,
  resetActiveSpooledUpdateHandlersForTests: resetTelegramPollingSessionStateForTest,
  resetTelegramRestartBackoffState,
  resolveSpooledUpdateRetryDelayMs,
  resolveTelegramRestartDelayMs,
  shouldDeadLetterRetryableSpooledUpdate,
  // Core drain refreshes every claimLeaseMs/3 (default 30m lease → 10m).
  spooledClaimRefreshIntervalMs: 10 * 60 * 1000,
  spooledRetryDeadLetterMinAgeMs: telegramSpooledRetryDeadLetterMinAgeMs,
  spooledRetryMaxAttempts: TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS,
};
// Mirrors core INGRESS_CLAIM_LEASE_MS (ingress-claim-owner).
const telegramSpooledUpdateClaimLeaseMs = 30 * 60 * 1000;
let claimNextTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.test-support.js").claimNextTelegramSpooledUpdate;
let listTelegramSpooledUpdateClaims: typeof import("./telegram-ingress-spool.test-support.js").listTelegramSpooledUpdateClaims;
let listTelegramSpooledUpdates: typeof import("./telegram-ingress-spool.test-support.js").listTelegramSpooledUpdates;
let recoverStaleTelegramSpooledUpdateClaims: typeof import("./telegram-ingress-spool.test-support.js").recoverStaleTelegramSpooledUpdateClaims;
let writeTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.test-support.js").writeTelegramSpooledUpdate;
let createTelegramSpooledReplayDeferredParticipant: typeof import("./bot-processing-outcome.js").createTelegramSpooledReplayDeferredParticipant;
type TelegramMessageProcessingResult =
  import("./bot-processing-outcome.js").TelegramMessageProcessingResult;
type TelegramSpooledReplayDeferredParticipant =
  import("./bot-processing-outcome.js").TelegramSpooledReplayDeferredParticipant;
async function claimSpooledUpdate(update: TelegramSpooledUpdate) {
  return await claimNextTelegramSpooledUpdate({
    spoolDir: path.dirname(update.path),
    candidateUpdateIds: [update.updateId],
  });
}

async function claimSpooledUpdateById(spoolDir: string, updateId: number) {
  const update = expectDefined(
    (await listTelegramSpooledUpdates({ spoolDir })).find((entry) => entry.updateId === updateId),
    `spooled update ${updateId}`,
  );
  return expectDefined(await claimSpooledUpdate(update), `claimed update ${updateId}`);
}

async function createTelegramMessageDispatchReplayForgetError(): Promise<unknown> {
  type ReplayGuard = Parameters<typeof commitTelegramMessageDispatchReplay>[0]["guard"];
  type ReplayClaim = import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle;
  const diskError = new Error("dedupe disk write failed");
  const guard: ReplayGuard = {
    claim: async () => ({ kind: "invalid" }),
    forget: async (event) => !("keys" in event && event.keys?.[0] === "first"),
    warmup: async () => 0,
  };
  const claims: ReplayClaim[] = ["first", "second"].map((key) => ({
    keys: [key],
    commit: async (options) => {
      if (key === "second") {
        options?.onDiskError?.(diskError);
      }
      return true;
    },
    release: () => undefined,
  }));
  try {
    await commitTelegramMessageDispatchReplay({
      guard,
      claims,
      requirePersistent: true,
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected Telegram dispatch rollback failure");
}

function collectDeferredParticipant(
  participants: TelegramSpooledReplayDeferredParticipant[],
  key: string,
): TelegramSpooledReplayDeferredParticipant {
  const participant = expectDefined(
    createTelegramSpooledReplayDeferredParticipant(key),
    "spooled replay participant",
  );
  participants.push(participant);
  return participant;
}

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
type TestWorkerMessage =
  | TelegramIngressWorkerMessage
  | { type: "poll-success"; finishedAt: number; count: number }
  | { type: "poll-error"; finishedAt: number; message: string };
type AsyncVoidFn = () => Promise<void>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
type TelegramPollingTestDatabase = Pick<
  OpenClawStateKyselyDatabaseForTests,
  "channel_ingress_events"
>;
type IsolatedIngressOptions = NonNullable<
  ConstructorParameters<typeof TelegramPollingSession>[0]["isolatedIngress"]
>;

const POLLING_TEST_WATCHDOG_INTERVAL_MS = 30_000;

function installTelegramIngressQueueRuntime(
  resolveStateDir: () => string,
  queueOpenError?: Error,
): void {
  setTelegramRuntime({
    state: {
      resolveStateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => {
        if (queueOpenError) {
          throw queueOpenError;
        }
        return createChannelIngressQueue({ ...options, channelId: "telegram" });
      },
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

function makeIsolatedBot(params?: {
  deleteWebhook?: () => Promise<boolean>;
  handleUpdate?: (update: { update_id?: number }) => Promise<unknown>;
  init?: AsyncVoidFn;
  stop?: AsyncVoidFn;
}) {
  return {
    api: {
      deleteWebhook: vi.fn(params?.deleteWebhook ?? (async () => true)),
      config: { use: vi.fn() },
    },
    init: vi.fn(params?.init ?? (async () => undefined)),
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "OpenClaw",
      username: "openclaw_bot",
      has_topics_enabled: false,
    } as NonNullable<ConstructorParameters<typeof TelegramPollingSession>[0]["botInfo"]>,
    handleUpdate: vi.fn(params?.handleUpdate ?? (async () => undefined)),
    stop: vi.fn(params?.stop ?? (async () => undefined)),
  };
}

function installPollingStallWatchdogHarness(dateNowSequence: readonly number[] = [0, 0]) {
  let monotonicNow = dateNowSequence[0] ?? 0;
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
  const performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
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
      monotonicNow = now;
      dateNowSpy.mockReset();
      dateNowSpy.mockImplementation(() => now);
    },
    restore() {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
      performanceNowSpy.mockRestore();
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

async function runTransportRestart(error: Error, recoverable = true) {
  const abort = new AbortController();
  const log = vi.fn();
  const firstTransport = makeTelegramTransport();
  const secondTransport = makeTelegramTransport();
  const createTelegramTransport = vi.fn(() => secondTransport);
  createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
  isRecoverableTelegramNetworkErrorMock.mockReturnValue(recoverable);
  mockRestartAfterPollingError(error, abort);

  const session = createPollingSession({
    abortSignal: abort.signal,
    log,
    telegramTransport: firstTransport,
    createTelegramTransport,
  });
  await session.runUntilAbort();
  return { createTelegramTransport, firstTransport, log, secondTransport };
}

function createPollingSession(params: {
  abortSignal: AbortSignal;
  log?: (message: string) => void;
  telegramTransport?: ReturnType<typeof makeTelegramTransport>;
  createTelegramTransport?: () => ReturnType<typeof makeTelegramTransport>;
  getAcceptedUpdateId?: () => number | null;
  getCommittedUpdateId?: () => number | null;
  persistUpdateId?: ConstructorParameters<typeof TelegramPollingSession>[0]["persistUpdateId"];
  stallThresholdMs?: number;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  isolatedIngress?: ConstructorParameters<typeof TelegramPollingSession>[0]["isolatedIngress"];
  botInfo?: ConstructorParameters<typeof TelegramPollingSession>[0]["botInfo"];
}) {
  return new TelegramPollingSession({
    token: "tok",
    config: {},
    accountId: "default",
    runtime: undefined,
    proxyFetch: undefined,
    abortSignal: params.abortSignal,
    runnerOptions: {},
    getAcceptedUpdateId: params.getAcceptedUpdateId ?? params.getCommittedUpdateId ?? (() => null),
    getCommittedUpdateId: params.getCommittedUpdateId ?? (() => null),
    persistUpdateId: params.persistUpdateId ?? (async () => undefined),
    log: params.log ?? (() => undefined),
    telegramTransport: params.telegramTransport,
    stallThresholdMs: params.stallThresholdMs,
    setStatus: params.setStatus,
    isolatedIngress: params.isolatedIngress,
    ...(params.botInfo ? { botInfo: params.botInfo } : {}),
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

type TestTelegramUpdate = Update & {
  message: NonNullable<Update["message"]> & { text: string };
};

const testTelegramSender = {
  id: 111,
  is_bot: false as const,
  first_name: "Ada",
};

function topicUpdate(updateId: number, threadId: number, text: string): TestTelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_736_380_800,
      from: testTelegramSender,
      text,
      message_thread_id: threadId,
      is_topic_message: true,
      chat: { id: -100, type: "supergroup", title: "Test group" },
    },
  };
}

function directUpdate(updateId: number, chatId: number, text: string): TestTelegramUpdate {
  const message = {
    message_id: updateId,
    date: 1_736_380_800,
    from: testTelegramSender,
    text,
  };
  if (chatId < 0) {
    return {
      update_id: updateId,
      message: {
        ...message,
        chat: { id: chatId, type: "supergroup", title: "Test group" },
      },
    };
  }
  return {
    update_id: updateId,
    message: {
      ...message,
      chat: { id: chatId, type: "private", first_name: "Ada" },
    },
  };
}

function forumUpdate(updateId: number, text: string) {
  const update = topicUpdate(updateId, 5907, text);
  update.message.chat.is_forum = true;
  return update;
}

async function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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
  const workerStop = vi.fn(async () => {
    stopWorker?.();
  });
  const createWorker = vi.fn(() => ({
    onMessage: vi.fn(() => () => undefined),
    stop: workerStop,
    task: vi.fn(async () => {
      await workerDone;
    }),
  }));
  return {
    createWorker,
    stop: () => stopWorker?.(),
    workerStop,
  };
}

function createListeningIngressWorker() {
  let listener: WorkerMessageListener | undefined;
  const idle = createIdleIngressWorker();
  const ackSpooledUpdate = vi.fn();
  const createWorker = vi.fn(() => {
    const worker = idle.createWorker();
    return {
      ...worker,
      ackSpooledUpdate,
      onMessage: vi.fn((nextListener: WorkerMessageListener) => {
        listener = nextListener;
        return () => undefined;
      }),
    };
  });
  return {
    ackSpooledUpdate,
    createWorker,
    emit: (message: TestWorkerMessage) => listener?.(message as TelegramIngressWorkerMessage),
    hasListener: () => listener !== undefined,
    stop: idle.stop,
    workerStop: idle.workerStop,
  };
}

function startIsolatedIngressSession(params: {
  abort: AbortController;
  spoolDir?: string;
  handleUpdate: (update: { update_id?: number }) => Promise<void>;
  createWorker?: IsolatedIngressOptions["createWorker"];
  drainIntervalMs?: number;
  getCommittedUpdateId?: () => number | null;
  init?: AsyncVoidFn;
  log?: (message: string) => void;
  persistUpdateId?: ConstructorParameters<typeof TelegramPollingSession>[0]["persistUpdateId"];
  stop?: () => Promise<void>;
  spooledUpdateHandlerTimeoutMs?: number;
  spooledUpdateHandlerAbortGraceMs?: number;
  stallThresholdMs?: number;
}) {
  const idleWorker = createIdleIngressWorker();
  const createWorker = params.createWorker ?? idleWorker.createWorker;
  const bot = makeIsolatedBot({
    handleUpdate: params.handleUpdate,
    init: params.init,
    stop: params.stop,
  });
  createTelegramBotMock.mockReturnValueOnce(bot);
  const session = createPollingSession({
    abortSignal: params.abort.signal,
    getCommittedUpdateId: params.getCommittedUpdateId,
    log: params.log,
    persistUpdateId: params.persistUpdateId,
    stallThresholdMs: params.stallThresholdMs,
    isolatedIngress: {
      enabled: true,
      createWorker,
      drainIntervalMs: params.drainIntervalMs ?? 10,
      ...(params.spoolDir ? { spoolDir: params.spoolDir } : {}),
      ...(params.spooledUpdateHandlerTimeoutMs !== undefined
        ? { spooledUpdateHandlerTimeoutMs: params.spooledUpdateHandlerTimeoutMs }
        : {}),
      ...(params.spooledUpdateHandlerAbortGraceMs !== undefined
        ? { spooledUpdateHandlerAbortGraceMs: params.spooledUpdateHandlerAbortGraceMs }
        : {}),
    },
  });
  return {
    createWorker,
    runPromise: session.runUntilAbort(),
    stopWorker: idleWorker.stop,
  };
}

describe("TelegramPollingSession", () => {
  beforeAll(async () => {
    ({ TelegramPollingSession } = await import("./polling-session.js"));
    ({
      claimNextTelegramSpooledUpdate,
      listTelegramSpooledUpdateClaims,
      listTelegramSpooledUpdates,
      recoverStaleTelegramSpooledUpdateClaims,
      writeTelegramSpooledUpdate,
    } = await import("./telegram-ingress-spool.test-support.js"));
    ({ createTelegramSpooledReplayDeferredParticipant } =
      await import("./bot-processing-outcome.js"));
  });

  beforeEach(() => {
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    isTelegramAuthenticationErrorMock.mockReset().mockReturnValue(false);
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

  it("keeps account work alive across recoverable classic polling retries", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const setStatus = vi.fn();
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
          const firstBotOptions = mockObjectArg(
            createTelegramBotMock,
            "first createTelegramBot",
            0,
          );
          const secondBotOptions = mockObjectArg(
            createTelegramBotMock,
            "second createTelegramBot",
            1,
          );
          expect((firstBotOptions.fetchAbortSignal as AbortSignal).aborted).toBe(true);
          expect(firstBotOptions.accountAbortSignal).toBe(abort.signal);
          expect(secondBotOptions.accountAbortSignal).toBe(abort.signal);
          expect(abort.signal.aborted).toBe(false);
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
      ownerAgentId: "ops",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getAcceptedUpdateId: () => null,
      getCommittedUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
      setStatus,
    });

    await session.runUntilAbort();

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(
      mockObjectArg(createTelegramBotMock, "createTelegramBot").minimumClientTimeoutSeconds,
    ).toBe(45);
    expect(mockObjectArg(createTelegramBotMock, "createTelegramBot").ownerAgentId).toBe("ops");
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
    expect(statusPatches(setStatus)).toContainEqual({ lifecycle: "recovering" });
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
      getAcceptedUpdateId: () => 41,
      getCommittedUpdateId: () => 41,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
    });

    await session.runUntilAbort();

    // Offset confirmation was removed because it could self-conflict with the runner.
    // OpenClaw middleware still skips duplicates using the persisted update offset.
    expect(bot.api.getUpdates).not.toHaveBeenCalled();
  });

  it("keeps legacy polling offset progress after a malformed update ID", async () => {
    const abort = new AbortController();
    const bot = makeBot();
    const writes: number[] = [];
    const onInvalidUpdateId = vi.fn();
    const offsetPersistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
      },
      onInvalidUpdateId,
      onRetry: vi.fn(),
    });
    createTelegramBotMock.mockReturnValueOnce(bot);
    mockLongRunningPollingCycle(vi.fn(async () => undefined));

    const session = createPollingSession({
      abortSignal: abort.signal,
      getAcceptedUpdateId: offsetPersistence.getAcceptedUpdateId,
      getCommittedUpdateId: offsetPersistence.getCommittedUpdateId,
      persistUpdateId: offsetPersistence.persistUpdateId,
    });
    const runPromise = session.runUntilAbort();
    try {
      await waitForTelegramTestState(() => expect(createTelegramBotMock).toHaveBeenCalledOnce());

      const updateOffset = mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset;
      if (!updateOffset || typeof updateOffset !== "object" || !("onUpdateId" in updateOffset)) {
        throw new Error("Expected legacy polling update-offset callback");
      }
      const onUpdateId = updateOffset.onUpdateId;
      if (typeof onUpdateId !== "function") {
        throw new Error("Expected legacy polling update-offset callback");
      }

      onUpdateId(Number.NaN);
      onUpdateId(101);
      await waitForTelegramTestState(() => expect(writes).toEqual([101]));

      expect(onInvalidUpdateId).toHaveBeenCalledWith(Number.NaN);
      expect(offsetPersistence.getCommittedUpdateId()).toBe(101);
    } finally {
      abort.abort();
      await runPromise;
      await offsetPersistence.stop();
    }
  });

  it("seeds a restarted classic polling cycle from accepted progress", async () => {
    const abort = new AbortController();
    let releaseWrite: (() => void) | undefined;
    const write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let restartFirstCycle: (() => void) | undefined;
    const restartSignal = new Promise<void>((resolve) => {
      restartFirstCycle = resolve;
    });
    const offsetPersistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async () => await write,
      onInvalidUpdateId: vi.fn(),
      onRetry: vi.fn(),
    });
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    runMock
      .mockReturnValueOnce({
        task: async () => {
          await restartSignal;
          throw new Error("restart classic polling");
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      })
      .mockReturnValueOnce({
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      });

    const session = createPollingSession({
      abortSignal: abort.signal,
      getAcceptedUpdateId: offsetPersistence.getAcceptedUpdateId,
      getCommittedUpdateId: offsetPersistence.getCommittedUpdateId,
      persistUpdateId: offsetPersistence.persistUpdateId,
    });
    const runPromise = session.runUntilAbort();
    try {
      await waitForTelegramTestState(() => expect(createTelegramBotMock).toHaveBeenCalledOnce());
      const firstOffset = mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset;
      if (!firstOffset || typeof firstOffset !== "object" || !("onUpdateId" in firstOffset)) {
        throw new Error("Expected classic polling update-offset callback");
      }
      const onUpdateId = firstOffset.onUpdateId;
      if (typeof onUpdateId !== "function") {
        throw new Error("Expected classic polling update-offset callback");
      }
      onUpdateId(101);

      expect(offsetPersistence.getAcceptedUpdateId()).toBe(101);
      expect(offsetPersistence.getCommittedUpdateId()).toBe(100);
      restartFirstCycle?.();
      await runPromise;

      const restartedOffset = mockObjectArg(
        createTelegramBotMock,
        "createTelegramBot",
        1,
      ).updateOffset;
      expect(restartedOffset).toMatchObject({
        lastUpdateId: 101,
        persistenceFloorUpdateId: 100,
      });
    } finally {
      releaseWrite?.();
      restartFirstCycle?.();
      abort.abort();
      await runPromise;
      await offsetPersistence.stop();
    }
  });

  it("does not start an isolated ingress worker when durable queue acquisition fails", async () => {
    await withTempSpool(async (spoolDir) => {
      const abort = new AbortController();
      const queueOpenError = new Error("Telegram ingress queue could not be opened");
      const transport = makeTelegramTransport();
      const bot = makeIsolatedBot();
      createTelegramBotMock.mockReturnValueOnce(bot);
      installTelegramIngressQueueRuntime(() => spoolDir, queueOpenError);

      let actualWorker: Worker | undefined;
      let workerReady: Promise<number> | undefined;
      const stopWorker = vi.fn(async () => {
        await actualWorker?.terminate();
      });
      const createWorker = vi.fn(() => {
        actualWorker = new Worker(
          `
            const http = require("node:http");
            const { parentPort } = require("node:worker_threads");
            const server = http.createServer((_request, response) => {
              response.end("worker-alive");
            });
            server.listen(0, "127.0.0.1", () => {
              parentPort.postMessage(server.address().port);
            });
          `,
          { eval: true, execArgv: [] },
        );
        workerReady = new Promise<number>((resolve, reject) => {
          actualWorker?.once("message", (port: number) => resolve(port));
          actualWorker?.once("error", reject);
        });
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: stopWorker,
          task: vi.fn(async () => undefined),
        };
      });
      const session = createPollingSession({
        abortSignal: abort.signal,
        telegramTransport: transport,
        isolatedIngress: {
          enabled: true,
          spoolDir,
          createWorker,
        },
      });

      try {
        await expect(session.runUntilAbort()).rejects.toBe(queueOpenError);
        expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(1);
        expect(transport.close).toHaveBeenCalledTimes(1);

        if (workerReady) {
          const port = await workerReady;
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          expect(response.status).toBe(200);
          expect(await response.text()).toBe("worker-alive");
          expect(stopWorker).not.toHaveBeenCalled();
        }

        expect(createWorker).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await actualWorker?.terminate();
      }
    });
  });

  it("initializes the main-thread bot before draining isolated ingress spool", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => undefined);
      const init = vi.fn(async () => undefined);
      const update = directUpdate(42, 123, "hello");
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update,
      });

      const { createWorker, runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate,
        init,
      });
      try {
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
        await waitForTelegramTestState(async () =>
          expect(
            await listTelegramSpooledUpdateClaims({
              spoolDir: tempDir,
            }),
          ).toEqual([]),
        );
      } finally {
        abort.abort();
        await runPromise;
      }

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
      });
      expect(init).toHaveBeenCalledBefore(handleUpdate);
      expect(handleUpdate).toHaveBeenCalledWith(update);
    });
  });

  it("writes isolated worker updates through the main runtime queue", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => undefined);
      const worker = createListeningIngressWorker();
      const update = directUpdate(42, 123, "hello");
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        worker.emit({
          type: "update",
          requestId: "write-1",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("write-1", {
            ok: true,
            updateId: 42,
          }),
        );
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledWith(update));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        abort.abort();
        await runPromise;
      }
    });
  });

  it.each([
    {
      name: "preserves a cached bot without making another getMe request",
      seeded: true,
      topicsEnabled: false,
      expectedGetMeCalls: 0,
      expectedLaneKey: "telegram:1234",
    },
    {
      name: "initializes an uncached bot with exactly one getMe request",
      seeded: false,
      topicsEnabled: true,
      expectedGetMeCalls: 1,
      expectedLaneKey: "telegram:1234:topic:42",
    },
  ])(
    "shares the installed grammY bot capability snapshot: $name",
    async ({ seeded, topicsEnabled, expectedGetMeCalls, expectedLaneKey }) => {
      await withTempSpool(async (tempDir) => {
        const abort = new AbortController();
        const worker = createListeningIngressWorker();
        const botInfo = {
          id: 123,
          is_bot: true,
          first_name: "OpenClaw",
          username: "openclaw_bot",
          has_topics_enabled: topicsEnabled,
        } as NonNullable<ConstructorParameters<typeof TelegramPollingSession>[0]["botInfo"]>;
        const bot = new Bot("tok", seeded ? { botInfo } : undefined);
        const getMe = vi.spyOn(bot.api, "getMe").mockResolvedValue(botInfo);
        vi.spyOn(bot.api, "deleteWebhook").mockResolvedValue(true);
        vi.spyOn(bot, "stop").mockResolvedValue(undefined);
        let releaseHandler: (() => void) | undefined;
        const handlerCompleted = new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        const handleUpdate = vi.spyOn(bot, "handleUpdate").mockImplementation(async () => {
          await handlerCompleted;
        });
        createTelegramBotMock.mockReturnValueOnce(bot);
        const session = createPollingSession({
          abortSignal: abort.signal,
          ...(seeded ? { botInfo } : {}),
          isolatedIngress: {
            enabled: true,
            spoolDir: tempDir,
            createWorker: worker.createWorker,
            drainIntervalMs: 10,
          },
        });
        const runPromise = session.runUntilAbort();
        try {
          await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
          worker.emit({
            type: "update",
            requestId: "topic-capability-1",
            update: {
              update_id: 143,
              message: {
                chat: { id: 1234, type: "private" },
                message_thread_id: 42,
                text: "installed bot capability snapshot",
              },
            },
            queued: 1,
          });
          await waitForTelegramTestState(() =>
            expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("topic-capability-1", {
              ok: true,
              updateId: 143,
            }),
          );
          await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledOnce());
          const { database, kysely } = openTelegramSpoolTestKysely(tempDir);
          const rows = executeSqliteQuerySync(
            database.db,
            kysely
              .selectFrom("channel_ingress_events")
              .select(["lane_key", "status"])
              .where("event_id", "=", String(143).padStart(16, "0")),
          ).rows;
          expect(rows).toMatchObject([{ lane_key: expectedLaneKey, status: "claimed" }]);
          expect(getMe).toHaveBeenCalledTimes(expectedGetMeCalls);
          expect(bot.botInfo).toBe(botInfo);
        } finally {
          releaseHandler?.();
          abort.abort();
          await runPromise;
        }
      });
    },
  );

  it("spools, persists the actual update id, then acknowledges", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const persistUpdateId = vi.fn(async (updateId: number) => {
        expect(updateId).toBe(42);
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]);
      });
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: vi.fn(async () => undefined),
        createWorker: worker.createWorker,
        drainIntervalMs: 60_000,
        getCommittedUpdateId: () => 40,
        persistUpdateId,
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        const update = directUpdate(42, 123, "hello");
        worker.emit({
          type: "update",
          requestId: "offset-gap",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("offset-gap", {
            ok: true,
            updateId: 42,
          }),
        );
        expect(
          expectDefined(persistUpdateId.mock.invocationCallOrder[0], "offset persistence order"),
        ).toBeLessThan(
          expectDefined(worker.ackSpooledUpdate.mock.invocationCallOrder[0], "worker ack order"),
        );
      } finally {
        abort.abort();
        await runPromise;
      }
    });
  });

  it("acknowledges a durable update when offset persistence fails", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: vi.fn(async () => undefined),
        createWorker: worker.createWorker,
        log,
        persistUpdateId: vi.fn(async () => {
          throw new Error("offset store unavailable");
        }),
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        const update = directUpdate(43, 123, "hello");
        worker.emit({
          type: "update",
          requestId: "offset-failure",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("offset-failure", {
            ok: true,
            updateId: 43,
          }),
        );
        expectLogIncludes(log, "isolated polling offset persist failed updateId=43");
      } finally {
        abort.abort();
        await runPromise;
      }
    });
  });

  it("keeps isolated intake moving while the durable offset catches up", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      let releaseOffsetWrite: (() => void) | undefined;
      const offsetWrite = new Promise<void>((resolve) => {
        releaseOffsetWrite = resolve;
      });
      const handleUpdate = vi.fn(async () => undefined);
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
        persistUpdateId: vi.fn(async () => await offsetWrite),
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        const update = directUpdate(44, 123, "hello");
        worker.emit({
          type: "update",
          requestId: "offset-catching-up",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("offset-catching-up", {
            ok: true,
            updateId: 44,
          }),
        );
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledOnce());
      } finally {
        releaseOffsetWrite?.();
        abort.abort();
        await runPromise;
      }
    });
  });

  it("recovers offset persistence and suppresses restart replay", async () => {
    await withTempSpool(async (tempDir) => {
      let durableUpdateId = 40;
      const writeUpdateId = vi
        .fn(async (updateId: number) => {
          durableUpdateId = updateId;
        })
        .mockRejectedValueOnce(new Error("offset store unavailable"));
      const firstOffsetPersistence = createTelegramUpdateOffsetPersistence({
        initialUpdateId: durableUpdateId,
        writeUpdateId,
        onInvalidUpdateId: vi.fn(),
        onRetry: vi.fn(),
      });
      const handleUpdate = vi.fn(async () => undefined);
      const firstAbort = new AbortController();
      const firstWorker = createListeningIngressWorker();
      const firstSession = startIsolatedIngressSession({
        abort: firstAbort,
        spoolDir: tempDir,
        handleUpdate,
        createWorker: firstWorker.createWorker,
        getCommittedUpdateId: firstOffsetPersistence.getCommittedUpdateId,
        persistUpdateId: firstOffsetPersistence.persistUpdateId,
      });
      const update = directUpdate(42, 123, "hello");
      try {
        await waitForTelegramTestState(() => expect(firstWorker.hasListener()).toBe(true));
        firstWorker.emit({
          type: "update",
          requestId: "first-delivery",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(firstWorker.ackSpooledUpdate).toHaveBeenCalledWith("first-delivery", {
            ok: true,
            updateId: 42,
          }),
        );
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledOnce());
        await waitForTelegramTestState(() =>
          expect(firstOffsetPersistence.getCommittedUpdateId()).toBe(42),
        );
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        firstAbort.abort();
        await firstSession.runPromise;
        await firstOffsetPersistence.stop();
      }

      expect(writeUpdateId).toHaveBeenCalledTimes(2);
      expect(durableUpdateId).toBe(42);

      const restartWriteUpdateId = vi.fn(async () => undefined);
      const restartedOffsetPersistence = createTelegramUpdateOffsetPersistence({
        initialUpdateId: durableUpdateId,
        writeUpdateId: restartWriteUpdateId,
        onInvalidUpdateId: vi.fn(),
        onRetry: vi.fn(),
      });
      const restartAbort = new AbortController();
      const restartWorker = createListeningIngressWorker();
      const restartedSession = startIsolatedIngressSession({
        abort: restartAbort,
        spoolDir: tempDir,
        handleUpdate,
        createWorker: restartWorker.createWorker,
        getCommittedUpdateId: restartedOffsetPersistence.getCommittedUpdateId,
        persistUpdateId: restartedOffsetPersistence.persistUpdateId,
      });
      try {
        await waitForTelegramTestState(() => expect(restartWorker.hasListener()).toBe(true));
        restartWorker.emit({
          type: "update",
          requestId: "restart-replay",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(restartWorker.ackSpooledUpdate).toHaveBeenCalledWith("restart-replay", {
            ok: true,
            updateId: 42,
          }),
        );
        expect(handleUpdate).toHaveBeenCalledOnce();
        expect(restartWriteUpdateId).not.toHaveBeenCalled();
      } finally {
        restartAbort.abort();
        await restartedSession.runPromise;
        await restartedOffsetPersistence.stop();
      }
    });
  });

  it("does not persist or acknowledge success when spooling fails", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const persistUpdateId = vi.fn(async () => undefined);
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: vi.fn(async () => undefined),
        createWorker: worker.createWorker,
        persistUpdateId,
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        worker.emit({
          type: "update",
          requestId: "spool-failure",
          update: { message: { text: "missing update id" } },
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("spool-failure", {
            ok: false,
            message: "Telegram update missing numeric update_id.",
          }),
        );
        expect(persistUpdateId).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await runPromise;
      }
    });
  });

  it("drains worker-spooled updates without waiting for the next drain interval", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => abort.abort());
      const worker = createListeningIngressWorker();
      const update = directUpdate(42, 123, "hello");
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
        drainIntervalMs: 60_000,
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        worker.emit({
          type: "update",
          requestId: "write-1",
          update,
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("write-1", {
            ok: true,
            updateId: 42,
          }),
        );
        worker.emit({ type: "spooled", updateId: 42, queued: 1 });
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledWith(update));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        abort.abort();
        await runPromise;
      }
    });
  });

  it("drains worker-spooled updates that arrive during an active drain", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
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

      const firstUpdate = directUpdate(1, 123, "pre-seeded");
      const secondUpdate = directUpdate(2, 123, "during-drain");
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update: firstUpdate,
      });
      const handleUpdate = vi.fn(async () => undefined);
      const worker = createListeningIngressWorker();

      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
        drainIntervalMs: 60_000,
      });

      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        await firstClaimStartedPromise;
        worker.emit({
          type: "update",
          requestId: "write-2",
          update: secondUpdate,
          queued: 1,
        });
        expect(worker.ackSpooledUpdate).not.toHaveBeenCalledWith("write-2", expect.anything());
        releaseFirstClaim?.();
        releaseFirstClaim = undefined;
        await waitForTelegramTestState(() =>
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("write-2", {
            ok: true,
            updateId: 2,
          }),
        );
        worker.emit({ type: "spooled", updateId: 2, queued: 1 });

        await waitForTelegramTestState(() =>
          expect(handleUpdate).toHaveBeenCalledWith(firstUpdate),
        );
        await waitForTelegramTestState(() =>
          expect(handleUpdate).toHaveBeenCalledWith(secondUpdate),
        );
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        releaseFirstClaim?.();
        abort.abort();
        await runPromise;
      }
    });
  });

  it("drains existing isolated ingress spool entries below the persisted offset", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => undefined);
      const update = directUpdate(42, 123, "pre-upgrade pending");
      await writeTelegramSpooledUpdate({
        spoolDir: tempDir,
        update,
      });

      const { createWorker, runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate,
        getCommittedUpdateId: () => 42,
      });
      try {
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
        await waitForTelegramTestState(async () =>
          expect(
            await listTelegramSpooledUpdateClaims({
              spoolDir: tempDir,
            }),
          ).toEqual([]),
        );
      } finally {
        abort.abort();
        await runPromise;
      }

      expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ initialUpdateId: 42 }));
      expect(mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset).toEqual({
        lastUpdateId: null,
        persistenceFloorUpdateId: 42,
      });
      expect(handleUpdate).toHaveBeenCalledWith(update);
    });
  });

  it("drains Telegram delivery queue after isolated ingress reports poll success", async () => {
    const abort = new AbortController();
    const init = vi.fn(async () => undefined);
    const worker = createListeningIngressWorker();
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      init,
      createWorker: worker.createWorker,
    });

    await waitForTelegramTestState(() => expect(init).toHaveBeenCalledTimes(1));
    worker.emit({ type: "poll-success", finishedAt: 10_000, count: 0 });
    worker.emit({ type: "poll-success", finishedAt: 10_001, count: 0 });

    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    worker.emit({ type: "poll-success", finishedAt: 15_000, count: 0 });
    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(2),
    );
    worker.emit({ type: "poll-error", finishedAt: 15_001, message: "offline" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    worker.emit({ type: "poll-success", finishedAt: 15_002, count: 0 });
    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(3),
    );

    abort.abort();
    await runPromise;
  });

  it("resets restart backoff after isolated ingress reports poll success", async () => {
    const abort = new AbortController();
    const init = vi.fn(async () => undefined);
    createTelegramBotMock.mockReturnValue(makeIsolatedBot({ init }));
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

  it("keeps a real polling worker alive during Telegram's server-directed flood wait", async () => {
    await withTempSpool(async (spoolDir) => {
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 180",
            parameters: { retry_after: 180 },
          }),
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a real loopback Bot API listener");
      }

      const abort = new AbortController();
      const log = vi.fn();
      const watchdogHarness = installPollingStallWatchdogHarness([0]);
      createTelegramBotMock.mockReturnValue(makeIsolatedBot());
      let actualWorker: Worker | undefined;
      let reportPollError: ((message: TelegramIngressWorkerMessage) => void) | undefined;
      const pollErrorReceived = new Promise<TelegramIngressWorkerMessage>((resolve) => {
        reportPollError = resolve;
      });
      const workerStop = vi.fn(async () => {
        if (actualWorker) {
          Reflect.apply(
            Reflect.get(actualWorker, "postMessage") as (message: unknown) => void,
            actualWorker,
            [{ type: "stop" }],
          );
          await actualWorker.terminate();
        }
      });
      const createWorker = vi.fn(() => {
        const worker = new Worker(
          new URL("./telegram-ingress-worker.runtime.ts", import.meta.url),
          {
            execArgv: ["--import", "tsx"],
            workerData: {
              runtime: TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER,
              token: "tok",
              accountId: "default",
              initialUpdateId: null,
              spoolDir,
              apiRoot: `http://127.0.0.1:${address.port}`,
              timeoutSeconds: 1,
            },
          },
        );
        actualWorker = worker;
        const task = new Promise<void>((resolve, reject) => {
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Telegram test worker exited with code ${code}`));
            }
          });
        });
        return {
          onMessage: vi.fn((listener: WorkerMessageListener) => {
            const forwardMessage = (message: TelegramIngressWorkerMessage) => {
              listener(message);
              if (message.type === "poll-error") {
                reportPollError?.(message);
              }
            };
            worker.on("message", forwardMessage);
            return () => worker.off("message", forwardMessage);
          }),
          stop: workerStop,
          task: () => task,
        };
      });
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        isolatedIngress: {
          enabled: true,
          createWorker,
          spoolDir,
        },
      });
      const runPromise = session.runUntilAbort();

      try {
        const watchdog = await watchdogHarness.waitForWatchdog();
        const pollError = await pollErrorReceived;
        expect(pollError).toMatchObject({ type: "poll-error", errorCode: 429 });
        expect(requestCount).toBe(1);

        for (const elapsedMs of [30_000, 60_000, 90_000, 120_000, 150_000]) {
          watchdogHarness.setNow(elapsedMs);
          watchdog();
        }

        expect(workerStop).not.toHaveBeenCalled();
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(pollError).toMatchObject({ retryAfterMs: 180_000 });
        expectLogExcludes(log, "Polling stall detected");
      } finally {
        abort.abort();
        await runPromise.catch(() => undefined);
        await actualWorker?.terminate();
        watchdogHarness.restore();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    });
  });

  it("caps an untrusted Telegram flood wait at the existing maximum polling threshold", async () => {
    const abort = new AbortController();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      createWorker: worker.createWorker,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({
        type: "poll-error",
        errorCode: 429,
        message: "Too Many Requests",
        finishedAt: 0,
        retryAfterMs: Number.MAX_VALUE,
      });

      for (let elapsedMs = 30_000; elapsedMs <= 600_000; elapsedMs += 30_000) {
        watchdogHarness.setNow(elapsedMs);
        watchdog();
        expect(worker.workerStop).not.toHaveBeenCalled();
      }

      watchdogHarness.setNow(630_000);
      watchdog();
      expect(worker.workerStop).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await runPromise;
      watchdogHarness.restore();
    }
  });

  it.each([
    { name: "missing flood wait", errorCode: 429, retryAfterMs: undefined },
    { name: "negative flood wait", errorCode: 429, retryAfterMs: -1 },
    { name: "zero flood wait", errorCode: 429, retryAfterMs: 0 },
    { name: "non-finite flood wait", errorCode: 429, retryAfterMs: Number.POSITIVE_INFINITY },
    { name: "server error", errorCode: 502, retryAfterMs: 180_000 },
    { name: "unauthorized bot", errorCode: 401, retryAfterMs: 180_000 },
    { name: "missing bot", errorCode: 404, retryAfterMs: 180_000 },
    { name: "webhook conflict", errorCode: 409, retryAfterMs: 180_000 },
  ])("does not disable the polling watchdog for $name", async ({ errorCode, retryAfterMs }) => {
    const abort = new AbortController();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      createWorker: worker.createWorker,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({
        type: "poll-error",
        errorCode,
        message: "Telegram polling error",
        finishedAt: 0,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });

      watchdogHarness.setNow(150_000);
      watchdog();
      expect(worker.workerStop).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await runPromise;
      watchdogHarness.restore();
    }
  });

  it("restores hung-poll detection when a new request ends a Telegram flood wait", async () => {
    const abort = new AbortController();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      createWorker: worker.createWorker,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({
        type: "poll-error",
        errorCode: 429,
        message: "Too Many Requests",
        finishedAt: 0,
        retryAfterMs: 180_000,
      });

      watchdogHarness.setNow(150_000);
      watchdog();
      expect(worker.workerStop).not.toHaveBeenCalled();

      worker.emit({ type: "poll-start", offset: null, startedAt: 150_000 });
      watchdogHarness.setNow(300_001);
      watchdog();
      expect(worker.workerStop).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await runPromise;
      watchdogHarness.restore();
    }
  });

  it("restarts isolated ingress when worker liveness stalls", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    createTelegramBotMock.mockReturnValue(makeIsolatedBot());

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

      await waitForTelegramTestState(() => expect(firstWorkerStop).toHaveBeenCalledTimes(1));
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));
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
    createTelegramBotMock.mockReturnValue(makeIsolatedBot());
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
      await waitForTelegramTestState(() =>
        expectLogIncludes(log, "Isolated polling ingress stop timed out"),
      );
      finishStoppedWorkers.shift()?.();
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));

      const secondWatchdog = await watchdogHarness.waitForWatchdogRegistration(2);
      watchdogHarness.setNow(62_000);
      secondWatchdog?.();
      await waitForTelegramTestState(() =>
        expectLogIncludes(log, "Stop timeout burst=2; applying cooldown."),
      );
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
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      log,
      stallThresholdMs: 30_000,
      createWorker: worker.createWorker,
      drainIntervalMs: 500,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({ type: "poll-start", offset: null, startedAt: 0 });
      watchdogHarness.setNow(31_000);
      worker.emit({ type: "spooled", updateId: 42, queued: 1 });
      watchdogHarness.setNow(45_000);
      watchdog?.();

      expect(worker.workerStop).not.toHaveBeenCalled();
      expectLogExcludes(log, "Polling stall detected");
    } finally {
      watchdogHarness.restore();
      abort.abort();
      await runPromise;
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

      await waitForTelegramTestState(() => expect(events).toEqual(["topic10:first", "topic11"]));
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

        await waitForTelegramTestState(() => expect(events).toEqual([42]));
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
        await waitForTelegramTestState(() => expect(events).toEqual(["topic10:42"]));
        const before = await claimedAtForUpdate(tempDir, 42);

        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        refreshHarness.triggerRefresh();
        await waitForTelegramTestState(async () =>
          expect(await claimedAtForUpdate(tempDir, 42)).toBeGreaterThan(before),
        );

        releaseHandler?.();
        await waitForTelegramTestState(async () =>
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
          collectDeferredParticipant(participants, `test-buffer:${update.update_id}`);
        },
      });

      // Telegram releases lane occupancy after each buffered update defers, while
      // retaining both durable claims until their participants settle.
      await waitForTelegramTestState(() => expect(events).toEqual(["topic10:42", "topic10:43"]));
      await waitForTelegramTestState(() => expect(participants).toHaveLength(2));
      await waitForTelegramTestState(async () =>
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([42, 43]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

      const completed: TelegramMessageProcessingResult = { kind: "completed" };
      participants[0]?.settle(completed);
      await waitForTelegramTestState(async () =>
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([43]),
      );
      participants[1]?.settle(completed);
      await waitForTelegramTestState(async () =>
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
          collectDeferredParticipant(participants, `test-buffer:${update.update_id}`);
        },
      });

      try {
        await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
        const before = await claimedAtForUpdate(tempDir, 42);

        await new Promise((resolve) => {
          setTimeout(resolve, 2);
        });
        refreshHarness.triggerRefresh();
        await waitForTelegramTestState(async () =>
          expect(await claimedAtForUpdate(tempDir, 42)).toBeGreaterThan(before),
        );

        participants[0]?.settle({ kind: "completed" });
        await waitForTelegramTestState(async () =>
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

  it("releases buffered spooled claims for retry when deferred processing fails", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const participants: TelegramSpooledReplayDeferredParticipant[] = [];
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "buffered failure")]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          collectDeferredParticipant(participants, `test-buffer:${update.update_id}`);
        },
      });

      await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
      await waitForTelegramTestState(async () =>
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
      stopWorker();
      await runPromise;
      // Shutdown may dispose before the retry result is persisted. The held
      // claim is still at-least-once state and is recovered by the next owner.
      await recoverStaleTelegramSpooledUpdateClaims({ spoolDir: tempDir, staleMs: 0 });
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
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
            collectDeferredParticipant(participants, `test-buffer:${update.update_id}`);
            return;
          }
          events.push(`duplicate-skip:${update.update_id}`);
        },
      });

      await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
      participants[0]?.settle({
        kind: "failed-retryable",
        error: await createTelegramMessageDispatchReplayForgetError(),
      });

      await waitForTelegramTestState(async () =>
        expect(await failedUpdateIds(tempDir)).toEqual([42]),
      );
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
          collectDeferredParticipant(participants, `test-buffer:${update.update_id}`);
        },
      });

      await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
      await waitForTelegramTestState(async () =>
        expect(await failedUpdateIds(tempDir)).toEqual([42]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      // Core drain watchdog log (display-id stripped of zero padding).
      expectLogIncludes(log, "claim→adoption stalled for event");
      expectLogIncludes(log, "handler-timeout");
      expectLogExcludes(log, "spooled update 42 failed; keeping for retry");
      expect(await failedUpdateReasons(tempDir)).toEqual([{ id: 42, reason: "handler-timeout" }]);
      abort.abort();
      stopWorker();
      await runPromise;
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
          const participant = collectDeferredParticipant(
            participants,
            `test-adopt:${update.update_id}`,
          );
          // Return immediately (deferred registered). Adoption settles the
          // spool row; the agent turn would continue under run lifecycle.
          queueMicrotask(() => {
            participant.settle({ kind: "completed" });
          });
        },
      });

      await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
      await waitForTelegramTestState(async () =>
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withTempSpool(async (tempDir) => {
        const abort = new AbortController();
        const participants: TelegramSpooledReplayDeferredParticipant[] = [];
        await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, "pre-adoption crash")]);

        const { runPromise, stopWorker } = startIsolatedIngressSession({
          abort,
          spoolDir: tempDir,
          drainIntervalMs: 10,
          handleUpdate: async (update) => {
            collectDeferredParticipant(participants, `test-pre-crash:${update.update_id}`);
            // Never adopt: process dies with claim held.
          },
        });

        await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
        await waitForTelegramTestState(async () =>
          expect(
            (await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).map((c) => c.updateId),
          ).toEqual([42]),
        );

        abort.abort();
        stopWorker();
        // Establish the same post-stop boundary as production without burning
        // the real 15-second graceful-stop ceiling on the abandoned handler.
        await vi.advanceTimersByTimeAsync(15_000);
        await runPromise;

        // Stale-claim recovery after crash: row is still claimed → replayable.
        await recoverStaleTelegramSpooledUpdateClaims({
          spoolDir: tempDir,
          staleMs: 0,
        });
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]);
        expect(await failedUpdateIds(tempDir)).toEqual([]);
      });
    } finally {
      vi.useRealTimers();
    }
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
          const participant = collectDeferredParticipant(
            participants,
            `test-post-crash:${update.update_id}`,
          );
          participant.settle({ kind: "completed" });
          // Turn would continue under run lifecycle; process crash after this is fine.
        },
      });

      await waitForTelegramTestState(() => expect(participants).toHaveLength(1));
      await waitForTelegramTestState(async () =>
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

      await waitForTelegramTestState(() => expect(events).toEqual(["throw:42"]));
      await waitForTelegramTestState(async () =>
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]),
      );
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
            const participant = collectDeferredParticipant(
              participants,
              `test-lane:${update.update_id}`,
            );
            // Adopt immediately so the lane frees while a long turn would
            // continue under run lifecycle (not retested here).
            participant.settle({ kind: "completed" });
          }
        },
      });

      await waitForTelegramTestState(() => expect(events).toContain("dispatch:42"));
      await waitForTelegramTestState(async () =>
        expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
      );
      // Lane free after adoption: second update reaches kernel dispatch.
      await waitForTelegramTestState(() => expect(events).toEqual(["dispatch:42", "dispatch:43"]));
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

      await waitForTelegramTestState(() =>
        expect(events).toEqual(["topic10:first", "topic11", "topic10:second"]),
      );
      await waitForTelegramTestState(async () =>
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
      );
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

        await waitForTelegramTestState(() => expect(poisonAttempts).toBe(1));
        await vi.advanceTimersByTimeAsync(130_000);

        await waitForTelegramTestState(() => expect(events.at(-1)).toBe("after-poison"));
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

          await waitForTelegramTestState(() => expect(attempts).toBeGreaterThanOrEqual(1));
          await waitForTelegramTestState(() => expect(events).toContain(scenario.otherEvent));
          expect(events).not.toContain(scenario.blockedEvent);
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([
            scenario.conflict.update_id,
            scenario.blocked.update_id,
          ]);
          expect(await failedUpdateIds(tempDir)).toEqual([]);

          await vi.advanceTimersByTimeAsync(1_200);
          await waitForTelegramTestState(() => expect(attempts).toBeGreaterThanOrEqual(2));
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

  it.each([
    {
      name: "dead-letters wrapped missing harness failures",
      text: "wrapped missing harness",
      wrap: (cause: Error) => new Error("Agent turn failed", { cause }),
    },
    {
      name: "dead-letters grammY BotError-wrapped missing harness failures",
      text: "bot error wrapped missing harness",
      wrap: (cause: Error) =>
        Object.assign(new Error("Error in middleware: Agent turn failed"), {
          name: "BotError",
          error: new Error("Agent turn failed", { cause }),
        }),
    },
  ])("$name", async ({ text, wrap }) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      await writeSpooledTestUpdates(tempDir, [topicUpdate(42, 10, text)]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        log,
        drainIntervalMs: 10,
        handleUpdate: async () => {
          const cause = new Error(
            'Requested agent harness "missing-harness-85470" is not registered.',
          );
          throw wrap(cause);
        },
      });

      await waitForTelegramTestState(async () =>
        expect(await failedUpdateIds(tempDir)).toEqual([42]),
      );
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
      await claimSpooledUpdateById(tempDir, 42);

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

      await waitForTelegramTestState(() => expect(events).toEqual(["handled:40"]));
      await waitForTelegramTestState(async () =>
        expect(await pendingUpdateIds(tempDir)).toEqual([]),
      );

      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "interrupted topic 10 turn"),
        topicUpdate(43, 10, "later topic 10 turn"),
      ]);
      await claimSpooledUpdateById(tempDir, 42);

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
      await claimSpooledUpdateById(tempDir, 42);
      const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        // starttime matches the live owner so process identity proves ownership.
        ownerId: `${liveOwnerPid}:5555:other-process`,
        claimedAt: Date.now(),
      });

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir: tempDir,
        staleMs: 0,
        shouldRecover: (claim) =>
          !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim, {
            processExists: (pid: number) => pid === liveOwnerPid,
            readProcessStartTime: (pid: number) => (pid === liveOwnerPid ? 5555 : null),
          }),
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
      await claimSpooledUpdateById(tempDir, 42);
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        ownerId: `${process.pid}:1:other-process`,
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

      await waitForTelegramTestState(() => expect(events).toEqual(["handled:42"]));
      await runPromise;
      expect(await failedUpdateReasons(tempDir)).toEqual([]);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([43]);
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      stopWorker();
    });
  });

  it("recovers a fresh claim whose pid now belongs only to a thread of this process", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "tid-reuse wedged turn"),
        topicUpdate(43, 10, "later same-lane turn"),
      ]);
      await claimSpooledUpdateById(tempDir, 42);
      // Old owner PID 9 is gone; a thread of this process now occupies numeric id 9.
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        ownerId: "9:1000:dead-owner",
        claimedAt: Date.now(),
      });

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir: tempDir,
        staleMs: 0,
        shouldRecover: (claim) =>
          !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim, {
            maxAgeMs: telegramSpooledUpdateClaimLeaseMs,
            processExists: (pid: number) => pid === 9,
            readProcessStartTime: (pid: number) => (pid === 9 ? 2000 : null),
          }),
      });
      expect(recovered).toBe(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([42, 43]);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          events.push(`handled:${update.update_id}`);
          if (events.length >= 2) {
            // Abort after this dispatch returns so 43 can tombstone first.
            queueMicrotask(() => abort.abort());
          }
        },
      });

      await waitForTelegramTestState(() => expect(events).toEqual(["handled:42", "handled:43"]));
      await runPromise;
      expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]);
      stopWorker();
    });
  });

  it("tombstones a post-adoption claim after restart without re-running the turn", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      // Simulate the crash window: turn was durably adopted (dispatch dedupe
      // committed / restart recovery will complete the run), but the ingress
      // claim was not yet tombstoned. Restart recovery does not store update_id,
      // so the claim is reclaimed and replayed; handleUpdate completes it with
      // no model re-dispatch (dedupe / skip path).
      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "adopted before crash"),
        topicUpdate(43, 10, "later same-lane turn"),
      ]);
      await claimSpooledUpdateById(tempDir, 42);
      await adoptClaimOwner({
        spoolDir: tempDir,
        updateId: 42,
        ownerId: "9:1000:dead-owner",
        claimedAt: Date.now(),
      });

      const recovered = await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir: tempDir,
        staleMs: 0,
        shouldRecover: (claim) =>
          !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim, {
            maxAgeMs: telegramSpooledUpdateClaimLeaseMs,
            processExists: (pid: number) => pid === 9,
            readProcessStartTime: (pid: number) => (pid === 9 ? 2000 : null),
          }),
      });
      expect(recovered).toBe(1);

      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        drainIntervalMs: 10,
        handleUpdate: async (update) => {
          // Replay of already-adopted update: no deferred participant / no model
          // dispatch — spool drain completes the row as a tombstone.
          events.push(`replay:${update.update_id}`);
        },
      });

      await waitForTelegramTestState(() => expect(events).toEqual(["replay:42", "replay:43"]));
      await waitForTelegramTestState(async () =>
        expect(await listTelegramSpooledUpdateClaims({ spoolDir: tempDir })).toEqual([]),
      );
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      abort.abort();
      stopWorker();
      await runPromise;
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
      await claimSpooledUpdateById(tempDir, 42);
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

      await waitForTelegramTestState(() => expect(events).toEqual([42, 43]));
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

      await waitForTelegramTestState(() =>
        expect(events).toEqual(["topic10:start", "handled:101"]),
      );
      releaseTopicTenTurn?.();
      await runPromise;
      expect(events).toEqual(["topic10:start", "handled:101", "topic10:end"]);
      releaseTopicTenTurn?.();
      stopWorker();
    });
  });

  it("recovers a lone active spooled handler owned by a replaced session (#84158)", async () => {
    // Core drain: a lone hanging claim is dead-lettered by the adoption-stall
    // watchdog so a replacement session is not blocked forever on that lane.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseTurn: (() => void) | undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const handleUpdate = vi.fn(async () => {
      await turnDone;
    });
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot({ handleUpdate }));
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
        log: vi.fn(),
        isolatedIngress: {
          enabled: true,
          spoolDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
          spooledUpdateHandlerTimeoutMs: 100,
        },
      });
      const firstRunPromise = firstSession.runUntilAbort();
      await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
      // Watchdog dead-letters the hanging claim before the session is replaced.
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForTelegramTestState(async () =>
        expect(await failedUpdateIds(tempDir)).toEqual([42]),
      );
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
          spooledUpdateHandlerTimeoutMs: 100,
        },
      });
      const secondRunPromise = secondSession.runUntilAbort();
      await vi.advanceTimersByTimeAsync(1_000);
      // Tombstoned/failed claim is not re-dispatched; replacement is unblocked.
      expect(handleUpdate).toHaveBeenCalledTimes(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);

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

  it.each([
    {
      name: "lets isolated ingress drain interleave different Telegram topic lanes",
      updates: [
        topicUpdate(42, 10, "long topic 10 turn"),
        topicUpdate(43, 11, "topic 11 turn"),
        topicUpdate(44, 10, "second topic 10 turn"),
      ],
      labels: ["topic10:start", "topic11", "topic10:end", "topic10:second"] as const,
    },
    {
      name: "lets isolated ingress drain interleave different Telegram chats",
      updates: [
        directUpdate(42, -100, "long first chat turn"),
        directUpdate(43, 854067528, "second chat turn"),
        directUpdate(44, -100, "second first chat turn"),
      ],
      labels: ["chatA:start", "chatB", "chatA:end", "chatA:second"] as const,
    },
  ])("$name", async ({ updates, labels }) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseFirstLane: (() => void) | undefined;
      const firstLaneDone = new Promise<void>((resolve) => {
        releaseFirstLane = resolve;
      });
      await writeSpooledTestUpdates(tempDir, updates);
      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          if (update.update_id === 42) {
            events.push(labels[0]);
            await firstLaneDone;
            events.push(labels[2]);
          } else if (update.update_id === 43) {
            events.push(labels[1]);
          } else if (update.update_id === 44) {
            events.push(labels[3]);
          }
        },
      });

      try {
        await waitForTelegramTestState(() => expect(events).toEqual(labels.slice(0, 2)));
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([44]);
        releaseFirstLane?.();
        await waitForTelegramTestState(() => expect(events).toEqual(labels));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        releaseFirstLane?.();
        abort.abort();
        stopWorker();
        await runPromise;
      }
    });
  });

  it("lets isolated ingress control updates bypass an active spooled turn", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseRegularTurn: (() => void) | undefined;
      const regularTurnDone = new Promise<void>((resolve) => {
        releaseRegularTurn = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [forumUpdate(42, "summarize this")]);
      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          if (update.update_id === 42) {
            events.push("regular:start");
            await regularTurnDone;
            events.push("regular:end");
          } else if (update.update_id === 43) {
            events.push("status");
          } else if (update.update_id === 44) {
            events.push("stop");
          }
        },
      });

      try {
        await waitForTelegramTestState(() => expect(events).toEqual(["regular:start"]));
        await writeSpooledTestUpdates(tempDir, [
          forumUpdate(43, "/status"),
          forumUpdate(44, "/stop@vacs_tars_bot"),
        ]);
        await waitForTelegramTestState(() =>
          expect(events).toEqual(["regular:start", "status", "stop"]),
        );
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
        releaseRegularTurn?.();
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        releaseRegularTurn?.();
        abort.abort();
        stopWorker();
        await runPromise;
      }
    });
  });

  it("preserves spool order when a control update is already queued after a regular turn", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseRegularTurn: (() => void) | undefined;
      const regularTurnDone = new Promise<void>((resolve) => {
        releaseRegularTurn = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [
        directUpdate(42, -100, "summarize this"),
        directUpdate(43, -100, "/status"),
      ]);
      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async (update) => {
          if (update.update_id === 42) {
            events.push("regular:start");
            await regularTurnDone;
            events.push("regular:end");
          } else if (update.update_id === 43) {
            events.push("status");
          }
        },
      });

      try {
        await waitForTelegramTestState(() => expect(events).toEqual(["regular:start", "status"]));
        releaseRegularTurn?.();
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        releaseRegularTurn?.();
        abort.abort();
        stopWorker();
        await runPromise;
      }
    });
  });

  it("waits for active spooled handlers before stopping the bot", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseRegularTurn: (() => void) | undefined;
      const regularTurnDone = new Promise<void>((resolve) => {
        releaseRegularTurn = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [directUpdate(42, -100, "summarize this")]);
      const { runPromise } = startIsolatedIngressSession({
        abort,
        spoolDir: tempDir,
        handleUpdate: async () => {
          events.push("regular:start");
          await regularTurnDone;
          events.push("regular:end");
        },
        stop: async () => {
          events.push("bot:stop");
        },
      });

      try {
        await waitForTelegramTestState(() => expect(events).toEqual(["regular:start"]));
        abort.abort();
        releaseRegularTurn?.();
        await runPromise;
        expect(events).toEqual(["regular:start", "regular:end", "bot:stop"]);
      } finally {
        releaseRegularTurn?.();
      }
    });
  });

  it("recovers orphaned spooled claims across isolated ingress restarts", async () => {
    // Core drain dispose leaves the claim for recover; the next cycle re-dispatches.
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
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot({ handleUpdate }));
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
      await waitForTelegramTestState(() =>
        expect(handleUpdate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      await vi.advanceTimersByTimeAsync(16_000);
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));
      // After cycle restart the orphaned claim is recovered (may already have
      // been re-dispatched by the time createWorker hits 2).
      await waitForTelegramTestState(() =>
        expect(handleUpdate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );

      releaseRegularTurn?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForTelegramTestState(async () =>
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
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
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot());

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
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));
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
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(1));

      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "crash the old bot"),
        topicUpdate(43, 11, "wait for the fresh bot"),
      ]);
      await vi.advanceTimersByTimeAsync(50);
      // Topic 42 starts on the first bot; topic 43 is a different lane and may
      // also start before the worker crash fully stops the cycle.
      await waitForTelegramTestState(() =>
        expect(firstHandleUpdate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      await waitForTelegramTestState(() => expect(sleepWithAbortMock).toHaveBeenCalledTimes(1));
      // While restart backoff is held, the fresh bot must not process updates.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(secondHandleUpdate).toHaveBeenCalledTimes(0);

      releaseBackoff?.();
      await vi.advanceTimersByTimeAsync(2_000);
      // Fresh bot drains remaining work (both lanes if still pending).
      await waitForTelegramTestState(() =>
        expect(secondHandleUpdate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;

      expect(createWorker).toHaveBeenCalledTimes(2);
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
      await waitForTelegramTestState(async () =>
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
      );

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
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot());

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
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(1));
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
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot());

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
          errorCode: 401,
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
          (patch) =>
            patch.connected === false &&
            patch.lifecycle === "blocked" &&
            patch.lastError === "Unauthorized",
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
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot({ deleteWebhook }));
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

  it("recovers orphaned spooled claims across account restarts", async () => {
    // Same as cycle restart: dispose leaves the claim; the new session recovers it.
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
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot({ handleUpdate }));
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
      await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
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
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(2));

      releaseRegularTurn?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForTelegramTestState(async () =>
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
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

  it("fails a timed-out spooled handler and drains later same-lane updates without restart", async () => {
    // Core drain: adoption-stall dead-letters 42 and frees the lane for 43 on
    // the same bot. Session restart on handler timeout is removed private-drain
    // behavior; the user-visible outcome is 42 failed and 43 processed.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const events: string[] = [];
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`bot:${update.update_id}`);
        if (update.update_id === 42) {
          // Hang until the core watchdog aborts the drain lifecycle.
          await new Promise<void>(() => {});
        }
        abort.abort();
      }),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValue(bot);
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
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      await waitForTelegramTestState(() => expect(events).toEqual(["bot:42"]));

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForTelegramTestState(async () =>
        expect(await failedUpdateIds(tempDir)).toEqual([42]),
      );
      await waitForTelegramTestState(() => expect(events).toEqual(["bot:42", "bot:43"]));
      await vi.advanceTimersByTimeAsync(15_000);
      await runPromise;

      // No private-drain session restart for handler timeout.
      expect(worker.createWorker).toHaveBeenCalledTimes(1);
      expect(createTelegramBotMock).toHaveBeenCalledTimes(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expectLogIncludes(log, "handler-timeout");
    } finally {
      abort.abort();
      worker.stop();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "forces a restart when polling stalls without getUpdates activity",
      reportsRunning: true,
      detailedAssertions: true,
      clock: [0, 0, 0, 0, 0],
    },
    {
      name: "forces a restart when the runner task is pending but reports not running",
      reportsRunning: false,
      detailedAssertions: false,
      clock: [0, 0],
    },
  ])("$name", async ({ reportsRunning, detailedAssertions, clock }) => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const firstBot = makeBot();
    firstBot.stop = botStop;
    createTelegramBotMock.mockReturnValueOnce(firstBot).mockReturnValueOnce(makeBot());
    const firstRunnerStop = vi.fn(async () => undefined);
    let firstTaskResolve: (() => void) | undefined;
    const firstTask = new Promise<void>((resolve) => {
      firstTaskResolve = resolve;
    });
    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      return cycle === 1
        ? {
            task: () => firstTask,
            stop: async () => {
              await firstRunnerStop();
              firstTaskResolve?.();
            },
            isRunning: () => reportsRunning,
          }
        : {
            task: async () => abort.abort(),
            stop: vi.fn(async () => undefined),
            isRunning: () => false,
          };
    });
    const watchdogHarness = installPollingStallWatchdogHarness(clock);
    const log = vi.fn();

    try {
      const runPromise = createPollingSession({ abortSignal: abort.signal, log }).runUntilAbort();
      const watchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(150_001);
      watchdog();
      await runPromise;

      expect(runMock).toHaveBeenCalledTimes(2);
      expect(firstRunnerStop).toHaveBeenCalledTimes(1);
      expectLogIncludes(log, "Polling stall detected");
      if (detailedAssertions) {
        expect(botStop).toHaveBeenCalledTimes(1);
        expectLogIncludes(log, "polling stall detected");
        expectLogExcludes(log, "Polling runner stop timed out");
      }
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
        getAcceptedUpdateId: () => null,
        getCommittedUpdateId: () => null,
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

  it.each([
    {
      name: "rebuilds the transport after a recoverable polling error",
      error: new Error("recoverable polling error"),
      recoverable: true,
      verify: ({
        createTelegramTransport,
        firstTransport,
        secondTransport,
      }: Awaited<ReturnType<typeof runTransportRestart>>) => {
        expectTelegramBotTransportSequence(firstTransport, secondTransport);
        expect(createTelegramTransport).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "rebuilds the transport after a getUpdates conflict to force a fresh TCP socket",
      error: Object.assign(new Error("Conflict: terminated by other getUpdates request"), {
        error_code: 409,
        method: "getUpdates",
      }),
      recoverable: false,
      verify: ({
        createTelegramTransport,
        firstTransport,
        secondTransport,
      }: Awaited<ReturnType<typeof runTransportRestart>>) => {
        expect(createTelegramTransport).toHaveBeenCalledTimes(1);
        expectTelegramBotTransportSequence(firstTransport, secondTransport);
        // A 409 rebuild closes the stale socket; session disposal closes its replacement.
        expect(firstTransport.close).toHaveBeenCalledTimes(1);
        expect(secondTransport.close).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "logs polling cycle start after a transport rebuild",
      error: new Error("recoverable polling error"),
      recoverable: true,
      verify: ({ log }: Awaited<ReturnType<typeof runTransportRestart>>) => {
        expectLogIncludes(log, "rebuilding transport for next polling cycle");
        expectLogIncludes(log, "polling cycle started");
      },
    },
    {
      name: "closes the stale transport when a rebuild replaces it",
      error: new Error("recoverable polling error"),
      recoverable: true,
      verify: ({
        firstTransport,
        secondTransport,
      }: Awaited<ReturnType<typeof runTransportRestart>>) => {
        expect(firstTransport.close).toHaveBeenCalled();
        expect(secondTransport.close).toHaveBeenCalled();
      },
    },
  ])("$name", async ({ error, recoverable, verify }) => {
    verify(await runTransportRestart(error, recoverable));
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
    expect(connectedPatch?.lifecycle).toBe("ready");
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

    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1),
    );
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

    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1),
    );
    await apiMiddleware(
      vi.fn(async () => []),
      "getUpdates",
      { offset: 3 },
    );
    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1),
    );
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
    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(2),
    );

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
    expect(statusPatches(setStatus)).toContainEqual({ lifecycle: "recovering" });
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
            patch.connected === false &&
            patch.lifecycle === "recovering" &&
            String(patch.lastError).includes("Polling stall detected"),
        ),
      ).toBe(true);
    } finally {
      watchdogHarness.restore();
    }
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
          patch.connected === false &&
          patch.lifecycle === "recovering" &&
          String(patch.lastError).includes("Another OpenClaw gateway"),
      ),
    ).toBe(true);
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
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
