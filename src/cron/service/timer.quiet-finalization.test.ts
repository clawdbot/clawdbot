import { afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { advanceCronActiveJobGeneration } from "../active-jobs.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { run } from "./ops-run.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-quiet-finalization",
});

function createDueIsolatedAgentJob(params: { now: number }): CronJob {
  return {
    id: "isolated-agent-job",
    agentId: "finn",
    name: "isolated agent job",
    enabled: true,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run isolated cron" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function findCronTaskByBaseRunId(baseRunId: string) {
  return (
    findTaskByRunId(baseRunId) ??
    listTaskRecordsUnsorted().find((task) => task.runId?.startsWith(`${baseRunId}:`))
  );
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron quiet task finalization", () => {
  it.each(
    ["timer", "retired-timer", "manual", "retired-manual"].flatMap((mode) =>
      [false, true].map((failWrite) => ({ mode, failWrite })),
    ),
  )(
    "finalizes quiet trigger tasks only after cron state persists ($mode, failWrite=$failWrite)",
    async ({ mode, failWrite }) => {
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-03-23T12:00:00.000Z");
      const job = {
        ...createDueIsolatedAgentJob({ now }),
        trigger: { script: "json({ fire: false })" },
      };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const finalizedAfterPersist: boolean[] = [];
      const database = openOpenClawStateDatabase().db;
      const finalize = taskExecutor.finalizeTaskRunByRunIdCore;
      const finalizeSpy = vi
        .spyOn(taskExecutor, "finalizeTaskRunByRunIdCore")
        .mockImplementation((params) => {
          const persistedJob = openOpenClawStateDatabase()
            .db.prepare(
              "SELECT json_extract(state_json, '$.runningAtMs') AS runningAtMs, json_extract(state_json, '$.nextRunAtMs') AS nextRunAtMs FROM cron_jobs WHERE store_key = ? AND job_id = ?",
            )
            .get(cronStoreKey(storePath), job.id) as {
            runningAtMs: number | null;
            nextRunAtMs: number | null;
          };
          finalizedAfterPersist.push(
            persistedJob.runningAtMs === null && (persistedJob.nextRunAtMs ?? 0) > now,
          );
          return finalize(params);
        });
      const state = createCronServiceState({
        defaultAgentId: "main",
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        evaluateCronTrigger: vi.fn(async () => {
          if (mode.startsWith("retired")) {
            advanceCronActiveJobGeneration();
          }
          return { kind: "evaluated" as const, fire: false };
        }),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      if (failWrite) {
        database.exec(`
        CREATE TEMP TRIGGER reject_quiet_terminal_row
        BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = 'isolated-agent-job'
          AND json_extract(OLD.state_json, '$.runningAtMs') IS NOT NULL
          AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'quiet row unavailable');
        END;
      `);
      }
      try {
        const execution = mode.endsWith("manual") ? run(state, job.id, "due") : onTimer(state);
        if (failWrite) {
          await expect(execution).rejects.toThrow("quiet row unavailable");
          expect(finalizedAfterPersist).toEqual([]);
          expect(findCronTaskByBaseRunId(`cron:${job.id}:${now}`)).toMatchObject({
            status: "running",
          });
          expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(now);
          return;
        }
        await execution;
        expect(finalizedAfterPersist).toEqual([true]);
        const task = findCronTaskByBaseRunId(`cron:${job.id}:${now}`);
        expect(task).toMatchObject({ status: "succeeded" });
        expect(task?.detail).toEqual({
          storeKey: cronStoreKey(storePath),
          triggerFired: false,
          triggerStateChanged: false,
        });
      } finally {
        stop(state);
        database.exec("DROP TRIGGER IF EXISTS reject_quiet_terminal_row");
        finalizeSpy.mockRestore();
      }
    },
  );
});
