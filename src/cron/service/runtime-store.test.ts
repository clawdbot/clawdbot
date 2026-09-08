import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { CronService } from "../service.js";
import { loadCronJobsStoreWithConfigJobs, loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  assertCronRunReceiptCurrent,
  claimCronRunReceiptInDatabase,
  CronRunReceiptRevisionError,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronStoredJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { armTimer } from "./timer.js";

const runtimeStoreFixtures = setupCronRegressionFixtures({ prefix: "cron-runtime-store-" });

function trackCronRowReads() {
  return trackSqliteStatementExecutions(
    openOpenClawStateDatabase().db,
    ["jobs", "authorities"] as const,
    (sql) => {
      if (sql.includes('from "cron_jobs"')) {
        return "jobs";
      }
      return sql.includes('from "cron_job_runtime_authorities"') ? "authorities" : null;
    },
  );
}

describe("cron runtime row publication", () => {
  afterEach(() => vi.useRealTimers());

  it("materializes only selected jobs and authority while preserving ordered, exact targets", async () => {
    const { storePath } = runtimeStoreFixtures.makeStorePath();
    const now = Date.now();
    const jobs: CronStoredJob[] = Array.from({ length: 128 }, (_, index) => ({
      ...createDueIsolatedJob({ id: `row-${index}`, nowMs: now, nextRunAtMs: now }),
      runtimeAuthority: {
        version: 1,
        runtimeId: "synthetic",
        namespace: "synthetic.apps",
        payload: { synthetic: true },
      },
    }));
    jobs.push({ ...jobs[0]!, id: "replacement-\ufffd" });
    await saveCronStore(storePath, { version: 1, jobs });
    const database = openOpenClawStateDatabase().db;
    const storeKey = cronStoreKey(storePath);
    database
      .prepare(
        "UPDATE cron_jobs SET state_json = 'invalid' WHERE store_key = ? AND job_id IN (?, ?)",
      )
      .run(storeKey, "row-0", "row-4");
    database
      .prepare(
        "UPDATE cron_job_runtime_authorities SET authority_json = '{}' WHERE store_key = ? AND job_id IN (?, ?)",
      )
      .run(storeKey, "row-1", "row-8");
    const before = database
      .prepare("SELECT * FROM cron_jobs WHERE store_key = ? ORDER BY sort_order")
      .all(storeKey);
    const state = createCronRegressionState({
      storePath,
      runIsolatedAgentJob: vi.fn(),
    });
    // A large missing-ID set must not hit SQLite's bound-parameter limit or widen the read.
    const targets = [
      "row-9",
      "row-4",
      "row-2",
      "row-8",
      "row-9",
      "replacement-\ud800",
      ...Array.from({ length: 33_000 }, (_, index) => `missing-${index}`),
    ];
    const reads = trackCronRowReads();
    let committed: string[];
    try {
      committed = commitCronRuntimeRows({
        state,
        jobIds: targets,
        operationLabel: "cron.selected-row-proof",
        mutate: ({ jobs: current }) => {
          expect(current.get("row-8")?.runtimeAuthorityRecoveryRequired).toBe(true);
          expect(current.get("row-2")?.runtimeAuthority).toEqual(jobs[2]!.runtimeAuthority);
          for (const job of current.values()) {
            job.state.lastError = "selected-row-marker";
          }
          return { value: [...current.keys()], upsertJobIds: current.keys() };
        },
      });
      expect(committed).toEqual(["row-2", "row-8", "row-9"]);
      // Include the malformed target and UTF-8 binding collision, but no unrelated job rows.
      expect(reads.rowCounts.jobs).toBeLessThanOrEqual(5);
      expect(reads.rowCounts.authorities).toBeLessThanOrEqual(4);
    } finally {
      reads.restore();
    }
    const after = database
      .prepare("SELECT * FROM cron_jobs WHERE store_key = ? ORDER BY sort_order")
      .all(storeKey);
    expect(after.filter((row) => !committed.includes(row.job_id as string))).toEqual(
      before.filter((row) => !committed.includes(row.job_id as string)),
    );
    expect(
      database
        .prepare(
          "SELECT job_id, recovery_required FROM cron_job_runtime_authorities WHERE store_key = ? AND job_id IN (?, ?) ORDER BY job_id",
        )
        .all(storeKey, "row-1", "row-8"),
    ).toEqual([
      { job_id: "row-1", recovery_required: 0 },
      { job_id: "row-8", recovery_required: 1 },
    ]);
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(loaded.invalidConfigRows.map((row) => row.sourceIndex)).toEqual([0, 4]);
    expect(
      loaded.store.jobs
        .filter((job) => job.state.lastError === "selected-row-marker")
        .map((job) => job.id),
    ).toEqual(committed);

    const emptyReads = trackCronRowReads();
    try {
      expect(
        commitCronRuntimeRows({
          state,
          jobIds: [],
          operationLabel: "cron.empty-row-proof",
          mutate: ({ jobs: current }) => ({ value: current.size }),
        }),
      ).toBe(0);
      expect(emptyReads.rowCounts).toEqual({ jobs: 0, authorities: 0 });
    } finally {
      emptyReads.restore();
    }
  });

  it("reads only the receipt's exact job and still rejects a malformed target", async () => {
    const { storePath } = runtimeStoreFixtures.makeStorePath();
    const now = Date.now();
    const jobs = Array.from({ length: 128 }, (_, index) =>
      createDueIsolatedJob({ id: `receipt-row-${index}`, nowMs: now, nextRunAtMs: now }),
    );
    await saveCronStore(storePath, { version: 1, jobs });
    const job = jobs[64]!;
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "main",
      startedAtMs: now,
    });
    const reads = trackCronRowReads();
    const handle = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({
        database: db,
        prepared,
        resolveAgentId: (current) => current.agentId ?? "main",
      }),
    );
    try {
      assertCronRunReceiptCurrent({
        handle,
        resolveAgentId: (current) => current.agentId ?? "main",
      });
      expect(reads.rowCounts.jobs).toBeLessThanOrEqual(2);
      openOpenClawStateDatabase()
        .db.prepare("UPDATE cron_jobs SET job_json = '{}' WHERE store_key = ? AND job_id = ?")
        .run(handle.storeKey, job.id);
      expect(() => assertCronRunReceiptCurrent({ handle, resolveAgentId: () => "main" })).toThrow(
        CronRunReceiptRevisionError,
      );
      expect(reads.rowCounts.jobs).toBeLessThanOrEqual(3);
    } finally {
      reads.restore();
      finishCronRunReceipt({ handle, status: "superseded", finishedAtMs: now + 1 });
    }
  });

  it("hands persisted authority to the runner and records its revocation failure", async () => {
    resetTaskRegistryForTests();
    const store = runtimeStoreFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job: CronStoredJob = createDueIsolatedJob({
      id: "manual-run-runtime-authority",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { auth: { managedRequirementsFingerprint: "f".repeat(64) } },
    };
    job.runtimeAuthority = runtimeAuthority;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const error = "Scheduled runtime authority was revoked. Reauthorize this automation.";
    const runIsolatedAgentJob = vi.fn().mockRejectedValue(new AgentHarnessPreflightError(error));
    const onEvent = vi.fn();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent,
    });

    try {
      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id, runtimeAuthority }),
        }),
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "finished", jobId: job.id, status: "error", error }),
      );
      expect(
        readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(store.storePath),
          jobId: job.id,
          limit: 1,
        }).entries,
      ).toMatchObject([{ jobId: job.id, status: "error", error }]);
      expect((await loadCronStore(store.storePath)).jobs).toMatchObject([
        {
          id: job.id,
          enabled: true,
          runtimeAuthority,
          state: { lastRunStatus: "error", lastError: error },
        },
      ]);
    } finally {
      cron.stop();
      resetTaskRegistryForTests();
    }
  });

  it("adds a sibling-imported row to memory before arming its timer", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-13T18:00:00.000Z");
    vi.setSystemTime(now);
    const resident = createDueIsolatedJob({
      id: "resident-job",
      nowMs: now,
      nextRunAtMs: now + 120_000,
    });
    resident.enabled = false;
    const imported = createDueIsolatedJob({
      id: "sibling-imported-job",
      nowMs: now,
      nextRunAtMs: now + 60_000,
    });
    const state = createCronRegressionState({
      storePath: "/tmp/runtime-store-import.json",
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(),
    });
    state.store = { version: 1, jobs: [resident] };

    applyCronRuntimeRowsToState(state, [imported]);
    armTimer(state);

    expect(state.store.jobs.map((job) => job.id)).toEqual([resident.id, imported.id]);
    expect(state.timer).not.toBeNull();
    stop(state);
  });
});
