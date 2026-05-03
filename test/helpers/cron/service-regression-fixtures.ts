import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { clearAllBootstrapSnapshots } from "../../../src/agents/bootstrap-cache.js";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions/store.js";
import { createCronServiceState, type CronServiceDeps } from "../../../src/cron/service/state.js";
import type { CronJob, CronJobState } from "../../../src/cron/types.js";
import { resetAgentRunContextForTest } from "../../../src/infra/agent-events.js";
import {
  resetCommandQueueStateForTest,
  waitForActiveTasks,
} from "../../../src/process/command-queue.js";
import { useFrozenTime, useRealTime } from "../../../src/test-utils/frozen-time.js";

const TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1_000;

export const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};

export function setupCronRegressionFixtures(options?: { prefix?: string; baseTimeIso?: string }) {
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "cron-issues-"));
  });

  beforeEach(() => {
    resetCommandQueueStateForTest();
    useFrozenTime(options?.baseTimeIso ?? "2026-02-06T10:05:00.000Z");
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    useRealTime();
    await waitForActiveTasks(250);
    resetCommandQueueStateForTest();
    clearSessionStoreCacheForTest();
    resetAgentRunContextForTest();
    clearAllBootstrapSnapshots();
  });

  afterAll(async () => {
    useRealTime();
    await waitForActiveTasks(250);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  return {
    makeStorePath() {
      return {
        storePath: path.join(fixtureRoot, `case-${fixtureCount++}.jobs.json`),
      };
    },
  };
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

export function topOfHourOffsetMs(jobId: string) {
  const digest = crypto.createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % TOP_OF_HOUR_STAGGER_MS;
}

export function createDueIsolatedJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
  deleteAfterRun?: boolean;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: params.deleteAfterRun ?? false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "at", at: new Date(params.nextRunAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: params.id },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

export function createDefaultIsolatedRunner(): CronServiceDeps["runIsolatedAgentJob"] {
  return vi.fn().mockResolvedValue({
    status: "ok",
    summary: "ok",
  }) as CronServiceDeps["runIsolatedAgentJob"];
}

export function createAbortAwareIsolatedRunner(summary = "late") {
  let observedAbortSignal: AbortSignal | undefined;
  const started = createDeferred<void>();
  const runIsolatedAgentJob = vi.fn(async ({ abortSignal, onExecutionStarted }) => {
    observedAbortSignal = abortSignal;
    started.resolve();
    onExecutionStarted?.();
    await new Promise<void>((resolve) => {
      if (!abortSignal) {
        return;
      }
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { status: "ok" as const, summary };
  }) as CronServiceDeps["runIsolatedAgentJob"];

  return {
    runIsolatedAgentJob,
    getObservedAbortSignal: () => observedAbortSignal,
    waitForStart: () => started.promise,
  };
}

export function createIsolatedRegressionJob(params: {
  id: string;
  name: string;
  scheduledAt: number;
  schedule: CronJob["schedule"];
  payload: CronJob["payload"];
  state?: CronJobState;
}): CronJob {
  return {
    id: params.id,
    name: params.name,
    enabled: true,
    createdAtMs: params.scheduledAt - 86_400_000,
    updatedAtMs: params.scheduledAt - 86_400_000,
    schedule: params.schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: params.payload,
    delivery: { mode: "announce" },
    state: params.state ?? {},
  };
}

export async function writeCronJobs(storePath: string, jobs: CronJob[]) {
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }), "utf-8");
}

export async function writeCronStoreSnapshot(storePath: string, jobs: unknown[]) {
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }), "utf-8");
}
