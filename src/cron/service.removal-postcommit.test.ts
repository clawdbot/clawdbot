import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { list, run } from "./service/ops.js";
import { createCronServiceState, type CronEvent, type CronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { runMissedJobs } from "./service/timer.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStoreModule from "./store.js";
import { loadCronStore, saveCronStore } from "./store.js";
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
  it("emits the full removal snapshot only after the deletion is durable", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const job = createDueOneShot(`postcommit-${path.replaceAll(" ", "-")}`, nowMs);
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const events: CronEvent[] = [];
    const durableJobsAtRemoval: Array<Promise<CronJob[]>> = [];
    const state = createState({
      storePath,
      nowMs,
      onEvent: (event) => {
        events.push(structuredClone(event));
        if (event.action === "removed") {
          durableJobsAtRemoval.push(loadCronStore(storePath).then((store) => store.jobs));
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
      expect(durableJobsAtRemoval).toHaveLength(1);
      await expect(Promise.all(durableJobsAtRemoval)).resolves.toEqual([[]]);
      expect(state.store?.jobs).toEqual([]);
    } finally {
      clearStateTimer(state);
    }
  });

  it("restores live and durable wake state when the final deletion write fails", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const job = createDueOneShot(`rollback-${path.replaceAll(" ", "-")}`, nowMs);
    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const events: CronEvent[] = [];
    let listedAfterFinished: Promise<CronJob[]> | undefined;
    const state = createState({
      storePath,
      nowMs,
      onEvent: (event) => {
        events.push(structuredClone(event));
        if (event.action === "finished") {
          // Models a detached hook: its read waits for the finalization lock,
          // then must see the rolled-back durable topology after write failure.
          listedAfterFinished = list(state, { includeDisabled: true });
        }
      },
    });

    const realSave = cronStoreModule.saveCronJobsStore;
    let finalDeletionAttempts = 0;
    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockImplementation(async (...args) => {
      const nextStore = args[1];
      if (!nextStore.jobs.some((entry) => entry.id === job.id)) {
        finalDeletionAttempts += 1;
        throw new Error("final persist failed");
      }
      await realSave(...args);
    });

    try {
      await expect(executeRemovalPath(path, state, job.id)).rejects.toThrow("final persist failed");

      expect(finalDeletionAttempts).toBe(1);
      expect(events.some((event) => event.action === "removed")).toBe(false);
      if (!listedAfterFinished) {
        throw new Error("missing detached finished-hook read");
      }
      await expect(listedAfterFinished).resolves.toEqual([expect.objectContaining({ id: job.id })]);

      const durableStore = await loadCronStore(storePath);
      expect(state.store).toEqual(durableStore);
      const durableJob = durableStore.jobs[0];
      expect(durableJob?.id).toBe(job.id);
      expect(state.durableNextRunAtMsByJobId).toEqual(
        new Map([[job.id, durableJob?.state.nextRunAtMs]]),
      );
    } finally {
      clearStateTimer(state);
    }
  });

  it("suppresses removal when quarantine prevents the durable write", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const job = createDueOneShot(`quarantine-${path.replaceAll(" ", "-")}`, nowMs);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const durableBefore = await loadCronStore(storePath);

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
    vi.spyOn(cronStoreModule, "saveCronQuarantineFile").mockRejectedValue(
      new Error("quarantine unavailable"),
    );
    const saveStore = vi.spyOn(cronStoreModule, "saveCronJobsStore");

    try {
      await expect(executeRemovalPath(path, state, job.id)).rejects.toThrow(
        "cron: durable store write did not complete",
      );

      expect(saveStore).not.toHaveBeenCalled();
      expect(events.some((event) => event.action === "removed")).toBe(false);
      const durableStore = await loadCronStore(storePath);
      expect(durableStore).toEqual(durableBefore);
      expect(state.store?.jobs).toEqual([
        expect.objectContaining({
          id: job.id,
          state: expect.objectContaining({
            nextRunAtMs: durableBefore.jobs[0]?.state.nextRunAtMs,
          }),
        }),
      ]);
      expect(state.durableNextRunAtMsByJobId).toEqual(
        new Map([[job.id, durableBefore.jobs[0]?.state.nextRunAtMs]]),
      );
    } finally {
      clearStateTimer(state);
    }
  });
});
