import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import { cronStoreKey } from "../cron/store/key.js";
import { cronRunLogEntryToTaskDetail, cronRunStatusToTaskStatus } from "../cron/task-run-detail.js";
import { readCronTaskRunHistoryPage } from "../cron/task-run-history.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID = "state:cron-run-logs-to-task-runs:v1";

describe("cron run-log task import", () => {
  it("imports legacy cron history into task runs once at state database open", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-run-log-import-" },
      async (state) => {
        const storePath = state.path("cron", "jobs.json");
        const storeKey = cronStoreKey(storePath);
        const jobId = "legacy-history-job";
        const entries: CronRunLogEntry[] = [
          {
            ts: 1_100,
            jobId,
            action: "finished",
            status: "ok",
            summary: "legacy one",
            sessionKey: "agent:main:cron:legacy:run:1",
            runId: "manual:legacy:1",
            runAtMs: 1_000,
            durationMs: 100,
          },
          {
            ts: 2_100,
            jobId,
            action: "finished",
            status: "error",
            error: "legacy failure",
            runAtMs: 2_000,
            durationMs: 100,
          },
          {
            ts: 2_100,
            jobId,
            action: "finished",
            status: "ok",
            summary: "same millisecond legacy run",
            runAtMs: 2_001,
            durationMs: 99,
          },
          {
            ts: 3_100,
            jobId,
            action: "finished",
            status: "error",
            error: "different public run id",
            runId: "manual:legacy:same-ts",
            runAtMs: 3_000,
            durationMs: 100,
          },
          {
            ts: 3_100,
            jobId,
            action: "finished",
            status: "skipped",
            runId: "manual:mirrored:3",
            runAtMs: 3_001,
            durationMs: 99,
          },
          {
            ts: 4_100,
            jobId,
            action: "finished",
            status: "ok",
            summary: "mirrored without public run id",
            runAtMs: 4_000,
            durationMs: 100,
          },
        ];
        const mirroredWithRunId = entries[4];
        if (!mirroredWithRunId) {
          throw new Error("expected mirrored cron history fixture");
        }
        const legacyRows = [...entries, { ...mirroredWithRunId }];

        const initial = openOpenClawStateDatabase();
        const databasePath = initial.path;
        closeOpenClawStateDatabaseForTest();
        const fixture = new DatabaseSync(databasePath);
        try {
          fixture.exec(`
            CREATE TABLE cron_run_logs (
              store_key TEXT NOT NULL,
              job_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              ts INTEGER NOT NULL,
              entry_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (store_key, job_id, seq)
            );
            CREATE INDEX idx_cron_run_logs_store_ts
              ON cron_run_logs(store_key, ts DESC, seq DESC);
          `);
          const insertLegacy = fixture.prepare(
            `INSERT INTO cron_run_logs
              (store_key, job_id, seq, ts, entry_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          for (const [index, entry] of legacyRows.entries()) {
            insertLegacy.run(
              storeKey,
              entry.jobId,
              index + 1,
              entry.ts,
              JSON.stringify(entry),
              entry.ts,
            );
          }
          const insertMirrored = fixture.prepare(
            `INSERT INTO task_runs (
                task_id, runtime, source_id, requester_session_key, owner_key, scope_kind,
                child_session_key, run_id, task, status, delivery_status, notify_policy, created_at,
                started_at, ended_at, last_event_at, error, terminal_summary, terminal_outcome,
                detail_json
              ) VALUES (?, 'cron', ?, '', '', 'system', ?, ?, ?, ?, 'not_applicable', 'silent',
                ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const [index, mirrored] of entries.slice(4).entries()) {
            const mirroredStatus = cronRunStatusToTaskStatus(mirrored);
            insertMirrored.run(
              `already-mirrored-${index}`,
              jobId,
              mirrored.sessionKey ?? null,
              `cron:legacy-history-job:${mirrored.runAtMs}:mirrored`,
              jobId,
              mirroredStatus,
              mirrored.runAtMs ?? mirrored.ts,
              mirrored.runAtMs ?? null,
              mirrored.ts,
              mirrored.ts,
              mirrored.error ?? null,
              mirrored.summary ?? null,
              mirroredStatus === "succeeded" ? "succeeded" : null,
              JSON.stringify(cronRunLogEntryToTaskDetail(mirrored, { storeKey })),
            );
          }
          fixture
            .prepare(
              `INSERT INTO cron_run_logs
                (store_key, job_id, seq, ts, entry_json, created_at)
               VALUES (?, ?, 8, 5100, '{', 5100)`,
            )
            .run(storeKey, jobId);
        } finally {
          fixture.close();
        }

        const reopened = openOpenClawStateDatabase();
        const report = reopened.db
          .prepare("SELECT report_json FROM migration_runs WHERE id = ?")
          .get(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID) as { report_json: string };
        expect(JSON.parse(report.report_json)).toEqual({
          imported: 4,
          alreadyMirrored: 3,
          malformed: 1,
          skipped: false,
        });
        const ledgerEntries = readCronTaskRunHistoryPage({
          storeKey,
          jobId,
          limit: 50,
          sortDir: "asc",
        }).entries;
        expect(
          ledgerEntries.map(({ ts, jobId: entryJobId, runId, summary, error }) => ({
            ts,
            jobId: entryJobId,
            runId,
            summary,
            error,
          })),
        ).toEqual(
          entries.map(({ ts, jobId: entryJobId, runId, summary, error }) => ({
            ts,
            jobId: entryJobId,
            runId,
            summary,
            error,
          })),
        );
        expect(
          reopened.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs'")
            .get(),
        ).toBeUndefined();
        const imported = reopened.db
          .prepare(
            "SELECT task_id, cleanup_after FROM task_runs WHERE task_id LIKE 'cron-runlog-import:%' ORDER BY task_id",
          )
          .all() as Array<{ task_id: string; cleanup_after: number | null }>;
        expect(imported).toHaveLength(4);
        expect(imported.map((row) => row.task_id)).toEqual([
          "cron-runlog-import:legacy-history-job:1100:1",
          "cron-runlog-import:legacy-history-job:2100:1",
          "cron-runlog-import:legacy-history-job:2100:2",
          "cron-runlog-import:legacy-history-job:3100:1",
        ]);
        expect(imported.every((row) => row.cleanup_after === null)).toBe(true);

        closeOpenClawStateDatabaseForTest();
        const secondOpen = openOpenClawStateDatabase();
        expect(secondOpen.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
          count: 6,
        });
        expect(
          secondOpen.db
            .prepare("SELECT report_json FROM migration_runs WHERE id = ?")
            .get(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID),
        ).toEqual({ report_json: report.report_json });
        resetTaskRegistryForTests({ persist: false });
      },
    );
  });
});
