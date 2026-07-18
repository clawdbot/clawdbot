// Cron service test harness builds isolated stores, timers, and delivery fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import { createCronServiceState, type CronServiceState } from "./service/state.js";
import type { CronServiceDeps } from "./service/state.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

type NoopLogger = {
  debug: MockFn;
  info: MockFn;
  warn: MockFn;
  error: MockFn;
};

export function createNoopLogger(): NoopLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createCronStoreHarness(options?: { prefix?: string }) {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-cron-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    return {
      storePath: path.join(dir, "cron", "jobs.json"),
      cleanup: async () => {},
    };
  }

  return { makeStorePath };
}

export async function writeCronStoreSnapshot(params: { storePath: string; jobs: CronJob[] }) {
  await saveCronStore(params.storePath, {
    version: 1,
    jobs: params.jobs,
  });
}

export function installCronTestHooks(options: {
  logger: ReturnType<typeof createNoopLogger>;
  baseTimeIso?: string;
}) {
  beforeEach(() => {
    vi.useFakeTimers();
    // Shared unit-thread workers run with isolate disabled, so leaked cron
    // timers from a previous file can still sit in the fake-timer queue.
    // Clear them before advancing time in the next test file.
    vi.clearAllTimers();
    vi.setSystemTime(new Date(options.baseTimeIso ?? "2025-12-13T00:00:00.000Z"));
    options.logger.debug.mockClear();
    options.logger.info.mockClear();
    options.logger.warn.mockClear();
    options.logger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}

export function setupCronServiceSuite(options?: { prefix?: string; baseTimeIso?: string }) {
  const logger = createNoopLogger();
  const { makeStorePath } = createCronStoreHarness({ prefix: options?.prefix });
  installCronTestHooks({
    logger,
    baseTimeIso: options?.baseTimeIso,
  });
  return { logger, makeStorePath };
}

export function createFinishedBarrier() {
  const resolvers = new Map<string, (evt: CronEvent) => void>();
  return {
    waitForOk: (jobId: string) =>
      new Promise<CronEvent>((resolve) => {
        resolvers.set(jobId, resolve);
      }),
    onEvent: (evt: CronEvent) => {
      if (evt.action !== "finished" || evt.status !== "ok") {
        return;
      }
      const resolve = resolvers.get(evt.jobId);
      if (!resolve) {
        return;
      }
      resolvers.delete(evt.jobId);
      resolve(evt);
    },
  };
}

export function createStartedCronServiceWithFinishedBarrier(params: {
  storePath: string;
  logger: ReturnType<typeof createNoopLogger>;
}): {
  cron: CronService;
  enqueueSystemEvent: MockFn;
  requestHeartbeat: MockFn;
  finished: ReturnType<typeof createFinishedBarrier>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: params.logger,
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent: finished.onEvent,
  });
  return { cron, enqueueSystemEvent, requestHeartbeat, finished };
}

export async function withCronServiceForTest(
  params: {
    makeStorePath: () => Promise<{ storePath: string; cleanup: () => Promise<void> }>;
    logger: ReturnType<typeof createNoopLogger>;
    cronEnabled: boolean;
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (context: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeat: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  const store = await params.makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const cron = new CronService({
    cronEnabled: params.cronEnabled,
    storePath: store.storePath,
    log: params.logger,
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob:
      params.runIsolatedAgentJob ??
      (vi.fn(async () => ({ status: "ok" as const, summary: "done" })) as never),
  });

  await cron.start();
  try {
    await run({ cron, enqueueSystemEvent, requestHeartbeat });
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

export function createRunningCronServiceState(params: {
  storePath: string;
  log: CronServiceDeps["log"];
  nowMs: () => number;
  jobs: CronJob[];
}) {
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: params.log,
    nowMs: params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
  });
  state.running = true;
  state.store = {
    version: 1,
    jobs: params.jobs,
  };
  return state;
}

function disposeCronServiceState(state: { timer: NodeJS.Timeout | null }): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export async function withCronServiceStateForTest<T>(
  state: { timer: NodeJS.Timeout | null },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    disposeCronServiceState(state);
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createMockCronStateForJobs(params: {
  jobs: CronJob[];
  nowMs?: number;
}): CronServiceState {
  const nowMs = params.nowMs ?? Date.now();
  return {
    store: { version: 1, jobs: params.jobs },
    durableNextRunAtMsByJobId: new Map<string, number | undefined>(),
    running: false,
    stopped: false,
    schedulingPaused: false,
    schedulerStarted: false,
    restartRecoveryPending: false,
    activeManualRunJobIds: new Set<string>(),
    manualSetupTimeoutNotified: false,
    runAdmission: { active: 0, waiters: [] },
    queuedRunReservationsByJobId: new Map(),
    timer: null,
    storeLoadedAtMs: nowMs,
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedInvalidPersistedJobKeys: new Set<string>(),
    pendingQuarantineConfigJobs: [],
    lastQuarantineFailureWarnKey: null,
    deps: {
      storePath: "/mock/path",
      cronEnabled: true,
      nowMs: () => nowMs,
      enqueueSystemEvent: () => {},
      requestHeartbeat: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
    },
  };
}
