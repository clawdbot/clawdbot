import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readCronJobScratchState, writeCronJobScratch } from "./scratch-store.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { add } from "./service/ops-mutations.js";
import { run } from "./service/ops-run.js";
import { createCronServiceState, type CronEvent, type CronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { runMissedJobs } from "./service/timer.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-removal-postcommit-",
  baseTimeIso: "2026-07-10T12:00:00.000Z",
});

type RemovalPath = "manual" | "timer" | "startup catch-up";

const removalPaths: RemovalPath[] = ["manual", "timer", "startup catch-up"];

function createDueOneShot(id: string, nowMs: number): CronJob {
  const runAtMs = nowMs - 60_000;
  return {
    id,
    name: `delete ${id}`,
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: runAtMs - 60_000,
    updatedAtMs: runAtMs - 60_000,
    schedule: { kind: "at", at: new Date(runAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    state: { nextRunAtMs: runAtMs },
  };
}

function createReplacementInput(id: string) {
  return {
    id,
    name: `replacement ${id}`,
    enabled: true,
    schedule: { kind: "every" as const, everyMs: 60_000 },
    sessionTarget: "isolated" as const,
    wakeMode: "next-heartbeat" as const,
    payload: { kind: "agentTurn" as const, message: "replacement work" },
  };
}

function createState(params: {
  storePath: string;
  nowMs: number;
  onEvent: (event: CronEvent) => void;
}): CronServiceState {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    onEvent: params.onEvent,
  });
}

async function executeRemovalPath(
  path: RemovalPath,
  state: CronServiceState,
  jobId: string,
): Promise<void> {
  if (path === "manual") {
    await run(state, jobId, "force");
    return;
  }
  if (path === "timer") {
    await onTimer(state);
    return;
  }
  await runMissedJobs(state);
}

function clearStateTimer(state: CronServiceState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

beforeEach(resetGatewayWorkAdmission);

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe.each(removalPaths)("cron one-shot removal via %s", (path) => {
  it("emits the full removal snapshot only after the job and scratch deletion are durable", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const job = createDueOneShot(`postcommit-${path.replaceAll(" ", "-")}`, nowMs);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    expect(
      writeCronJobScratch({
        storePath,
        jobId: job.id,
        content: "original scratch",
        nowMs: nowMs - 1,
      }),
    ).toMatchObject({ ok: true, currentRevision: 1 });

    const events: CronEvent[] = [];
    const durableStateAtRemoval: Array<
      Promise<{
        jobs: CronJob[];
        scratch: ReturnType<typeof readCronJobScratchState>;
      }>
    > = [];
    const state = createState({
      storePath,
      nowMs,
      onEvent: (event) => {
        events.push(structuredClone(event));
        if (event.action === "removed") {
          const scratch = readCronJobScratchState(storePath, job.id);
          durableStateAtRemoval.push(
            loadCronStore(storePath).then((store) => ({ jobs: store.jobs, scratch })),
          );
        }
      },
    });

    try {
      await executeRemovalPath(path, state, job.id);

      const relevantEvents = events.filter((event) => event.jobId === job.id);
      expect(relevantEvents.map((event) => event.action)).toEqual([
        "started",
        "finished",
        "removed",
      ]);
      const removed = relevantEvents.at(-1);
      expect(removed).toMatchObject({
        action: "removed",
        jobId: job.id,
        job: {
          id: job.id,
          name: job.name,
          deleteAfterRun: true,
          state: {
            lastRunStatus: "ok",
            lastStatus: "ok",
          },
        },
      });
      expect(durableStateAtRemoval).toHaveLength(1);
      await expect(Promise.all(durableStateAtRemoval)).resolves.toEqual([
        { jobs: [], scratch: { currentRevision: 0 } },
      ]);
      expect(state.store?.jobs).toEqual([]);

      const replacement = await add(state, createReplacementInput(job.id));
      expect(replacement.id).toBe(job.id);
      expect(readCronJobScratchState(storePath, job.id)).toEqual({ currentRevision: 0 });
    } finally {
      clearStateTimer(state);
    }
  });

  it("restores live and durable wake state when the final deletion write fails", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const job = createDueOneShot(`rollback-${path.replaceAll(" ", "-")}`, nowMs);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    writeCronJobScratch({
      storePath,
      jobId: job.id,
      content: "scratch must survive rollback",
      sourceSha256: "original-source",
      nowMs: nowMs - 1,
    });
    const scratchBefore = readCronJobScratchState(storePath, job.id);

    const events: CronEvent[] = [];
    const state = createState({
      storePath,
      nowMs,
      onEvent: (event) => events.push(structuredClone(event)),
    });

    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_final_cron_job_delete
      BEFORE DELETE ON cron_jobs
      WHEN OLD.store_key = '${cronStoreKey(storePath)}' AND OLD.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'final persist failed');
      END;
    `);

    try {
      await expect(executeRemovalPath(path, state, job.id)).rejects.toThrow("final persist failed");

      expect(events.some((event) => event.action === "removed")).toBe(false);

      const durableStore = await loadCronStore(storePath);
      expect(state.store).toEqual(durableStore);
      const durableJob = durableStore.jobs[0];
      expect(durableJob?.id).toBe(job.id);
      expect(state.durableNextRunAtMsByJobId).toEqual(
        new Map([[job.id, durableJob?.state.nextRunAtMs]]),
      );
      expect(readCronJobScratchState(storePath, job.id)).toEqual(scratchBefore);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_final_cron_job_delete");
      clearStateTimer(state);
    }
  });

  it("keeps runtime removal independent from unrelated quarantine persistence", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const job = createDueOneShot(`quarantine-${path.replaceAll(" ", "-")}`, nowMs);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const events: CronEvent[] = [];
    const state = createState({
      storePath,
      nowMs,
      onEvent: (event) => events.push(structuredClone(event)),
    });
    await ensureLoaded(state, { skipRecompute: true });
    state.pendingQuarantineConfigJobs = [
      { sourceIndex: 0, reason: "invalid-schedule", job: { id: "quarantined-job" } },
    ];
    try {
      await expect(executeRemovalPath(path, state, job.id)).resolves.toBeUndefined();

      expect(events.some((event) => event.action === "removed")).toBe(true);
      const durableStore = await loadCronStore(storePath);
      expect(durableStore.jobs).toEqual([]);
      expect(state.store?.jobs).toEqual([]);
      expect(state.pendingQuarantineConfigJobs).toHaveLength(1);
    } finally {
      clearStateTimer(state);
    }
  });
});
