import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronJobActive,
  markCronJobActive,
} from "../active-jobs.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  inspectActiveCronRunReceipt,
  prepareCronRunReceiptClaim,
  type CronRunReceiptHandle,
} from "../store/run-receipt-store.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { locked } from "./locked.js";
import { start, stop } from "./ops-lifecycle.js";
import { remove, update } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { tryCreateCronTaskRunHandle } from "./task-runs.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-lifecycle-" });

describe.each([
  "stopped",
  "retired",
  "rescheduled",
  "manual",
  "manual-future",
  "manual-delayed-force",
  "manual-replaced",
  "manual-write-failure",
  "manual-write-failure-live",
  "manual-removed",
] as const)("one-shot recovery when %s", (mode) => {
  it.each(["ok", "error", "skipped"] as const)(
    "does not replay a run that finishes as %s after stopping",
    async (status) => {
      const { storePath } = await makeStorePath();
      const nowMs = Date.now();
      const atMs = nowMs + (mode === "manual-future" ? 60_000 : 0);
      const manual = mode.startsWith("manual");
      const writeFailure = mode.startsWith("manual-write-failure");
      const job: CronJob = {
        id: "shutdown-one-shot",
        agentId: "alpha",
        name: "shutdown one-shot",
        enabled: true,
        deleteAfterRun: !writeFailure,
        createdAtMs: nowMs - 1,
        updatedAtMs: nowMs - 1,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "command", argv: ["true"] },
        delivery: { mode: "none" },
        state: { nextRunAtMs: atMs },
      };
      if (mode === "manual" && status === "error") {
        job.failureAlert = { after: 1, cooldownMs: 60_000, channel: "last" };
      }
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const failureDatabase = writeFailure ? openOpenClawStateDatabase().db : undefined;
      const started = createDeferred();
      const completion = createDeferred<{ status: CronRunStatus; error?: string }>();
      const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>(async () => {
        started.resolve();
        return completion.promise;
      });
      const onEvent = vi.fn();
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const freshState = () =>
        createCronServiceState({
          storePath,
          cronEnabled: true,
          log: logger,
          nowMs: Date.now,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          runCommandJob,
          onEvent,
          sendCronFailureAlert,
        });
      const first = freshState();
      // An earlier repair can commit before its interrupted-task notification.
      // That orphan shares this start millisecond, but not this run's receipt.
      tryCreateCronTaskRunHandle({ state: first, job, startedAt: nowMs });
      const startup = manual
        ? run(
            first,
            job.id,
            mode === "manual-future" || mode === "manual-delayed-force" ? "force" : undefined,
            mode === "manual-delayed-force" ? { scheduleOwnershipAtMs: nowMs - 1 } : undefined,
          )
        : start(first);
      const settledStartup = startup.then(
        () => undefined,
        (error: unknown) => error,
      );
      let successor: CronRunReceiptHandle | undefined;
      let successorMarker: ReturnType<typeof markCronJobActive>;
      try {
        await started.promise;
        const admittedReceipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        if (mode === "manual-removed") {
          const entered = createDeferred();
          const unblock = createDeferred();
          const blocker = locked(first, async () => {
            entered.resolve();
            await unblock.promise;
          });
          await entered.promise;
          const removal = remove(first, job.id);
          const queuedRemoval = first.op;
          completion.resolve({ status });
          try {
            // Queue finalization behind removal, after its first removed check.
            await vi.waitFor(() => expect(first.op).not.toBe(queuedRemoval));
          } finally {
            unblock.resolve();
            await blocker;
            await removal;
          }
        }
        if (mode === "rescheduled") {
          // A separate service owns the edit; the finishing service must reload
          // its schedule fence rather than delete the replacement on success.
          const editor = freshState();
          try {
            await update(editor, job.id, {
              schedule: { kind: "at", at: new Date(nowMs + 60_000).toISOString() },
            });
          } finally {
            stop(editor);
          }
        }
        stop(first);
        if (mode === "retired" || (manual && mode !== "manual-write-failure-live")) {
          advanceCronActiveJobGeneration();
        }
        failureDatabase?.exec(`
          CREATE TEMP TRIGGER reject_manual_terminal_row
          BEFORE UPDATE ON cron_jobs
          WHEN NEW.job_id = 'shutdown-one-shot'
            AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
          BEGIN
            SELECT RAISE(ABORT, 'manual row unavailable');
          END;
        `);
        if (mode === "manual-replaced") {
          const previous = inspectActiveCronRunReceipt({ storePath, jobId: job.id })!;
          // Simulate an authoritative replacement while the retired caller still
          // holds its result; process-local settlement cannot grant it ownership.
          runOpenClawStateWriteTransaction(({ db }) =>
            finishCronRunReceiptInDatabase({
              database: db,
              handle: previous,
              status: "superseded",
              finishedAtMs: nowMs,
            }),
          );
          const prepared = prepareCronRunReceiptClaim({
            storePath,
            job,
            agentId: "alpha",
            startedAtMs: nowMs,
          });
          successor = runOpenClawStateWriteTransaction(({ db }) =>
            claimCronRunReceiptInDatabase({
              database: db,
              prepared,
              resolveAgentId: () => "alpha",
            }),
          );
          successorMarker = markCronJobActive(job.id);
        }
        completion.resolve({ status, error: status === "error" ? "command failed" : undefined });
        if (writeFailure) {
          expect(await settledStartup).toMatchObject({
            message: expect.stringContaining("manual row unavailable"),
          });
          failureDatabase?.exec("DROP TRIGGER reject_manual_terminal_row");
          expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toMatchObject({
            receiptId: admittedReceipt?.receiptId,
          });
        } else {
          expect(await settledStartup).toBeUndefined();
        }
        if (mode === "manual" && status === "error") {
          await vi.waitFor(() => expect(sendCronFailureAlert).toHaveBeenCalledOnce());
        }
        const finished = onEvent.mock.calls.filter(([event]) => event.action === "finished");
        if (mode === "manual-removed") {
          expect(finished).toHaveLength(1);
          expect(
            readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id })
              .entries,
          ).toHaveLength(1);
          expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
          expect(isCronJobActive(job.id)).toBe(false);
        } else {
          expect(finished).toEqual([]);
        }
        if (mode === "manual-delayed-force") {
          expect((await loadCronStore(storePath)).jobs).toMatchObject([
            { enabled: true, state: { nextRunAtMs: atMs, forcePreservedNextRunAtMs: atMs } },
          ]);
        }
        for (let restart = 0; restart < 3; restart += 1) {
          const next = freshState();
          try {
            await start(next);
            if (mode === "manual-delayed-force") {
              await vi.advanceTimersByTimeAsync(MIN_REFIRE_GAP_MS);
              await vi.waitFor(async () =>
                expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBeUndefined(),
              );
            }
            // A force run reserved before the slot borrows it; once due, its
            // distinct scheduled occurrence still runs exactly once.
            expect(runCommandJob).toHaveBeenCalledTimes(mode === "manual-delayed-force" ? 2 : 1);
            const jobs = (await loadCronStore(storePath)).jobs;
            if (mode === "manual-removed") {
              expect(jobs).toHaveLength(0);
              continue;
            }
            if (successor) {
              expect(jobs[0]?.state.runningAtMs).toBe(nowMs);
              expect(jobs[0]?.state.lastRunStatus).toBeUndefined();
              expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })?.receiptId).toBe(
                successor.receiptId,
              );
              expect(isCronJobActive(job.id)).toBe(true);
              continue;
            }
            expect(jobs[0]?.state.runningAtMs).toBeUndefined();
            if (mode === "rescheduled" || mode === "manual-future") {
              expect(jobs).toMatchObject([
                {
                  enabled: true,
                  state: {
                    lastRunStatus: status,
                    nextRunAtMs: nowMs + 60_000,
                    ...(mode === "rescheduled" ? { scheduleActivatedAtMs: nowMs } : {}),
                  },
                },
              ]);
            } else if (status === "ok" && !writeFailure) {
              expect(jobs).toHaveLength(0);
            } else {
              expect(jobs).toMatchObject([{ enabled: false, state: { lastRunStatus: status } }]);
              expect(jobs[0]?.state.startupCatchupAtMs).toBeUndefined();
              expect(jobs[0]?.state.nextRunAtMs).toBeUndefined();
            }
          } finally {
            stop(next);
          }
        }
      } finally {
        stop(first);
        completion.resolve({ status });
        await settledStartup;
        failureDatabase?.exec("DROP TRIGGER IF EXISTS reject_manual_terminal_row");
        if (successor) {
          finishCronRunReceipt({ handle: successor, status: "skipped", finishedAtMs: nowMs });
          clearCronJobActive(job.id, successorMarker);
        }
      }
    },
  );
});
