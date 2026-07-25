import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { saveTaskRegistryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { cronStoreKey } from "./store/key.js";
import {
  cronRunLogEntryToTaskDetail,
  cronRunStatusToTaskStatus,
  cronTaskRecordToRunLogEntry,
  parseCronRunLogEntryObject,
} from "./task-run-detail.js";
import { cronRunLogEntryFromEvent } from "./task-run-event-codec.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

const JOB_ID = "history-job";

function taskFromEntry(entry: CronRunLogEntry, index: number, storeKey: string): TaskRecord {
  return {
    taskId: `task-${index}`,
    runtime: "cron",
    sourceId: entry.jobId,
    requesterSessionKey: "",
    ownerKey: "",
    scopeKind: "system",
    ...(entry.sessionKey ? { childSessionKey: entry.sessionKey } : {}),
    agentId: "main",
    runId: `cron:${entry.jobId}:${entry.runAtMs ?? entry.ts}`,
    task: JOB_ID,
    status: cronRunStatusToTaskStatus(entry),
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: entry.runAtMs ?? entry.ts,
    startedAt: entry.runAtMs,
    endedAt: entry.ts,
    lastEventAt: entry.ts,
    error: entry.error,
    terminalSummary: entry.summary,
    detail: cronRunLogEntryToTaskDetail(entry, { storeKey }),
  };
}

function futureCronDetailTask(storeKey: string): TaskRecord {
  return {
    ...taskFromEntry(
      {
        ts: 400,
        jobId: JOB_ID,
        action: "finished",
        status: "ok",
        runAtMs: 390,
        durationMs: 10,
      },
      4,
      storeKey,
    ),
    taskId: "future-detail",
    detail: { kind: "future-cron-detail", status: "ok" },
  };
}

describe("cron task run history", () => {
  it("reads executions produced by the cron service from the ledger", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-service-history-" },
      async (state) => {
        resetTaskRegistryForTests();
        const storePath = state.path("cron", "jobs.json");
        let now = Date.parse("2026-07-12T12:00:00.000Z");
        const cron = new CronService({
          storePath,
          cronEnabled: true,
          cronConfig: { triggers: { enabled: true } },
          log: createNoopLogger(),
          nowMs: () => now,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          evaluateCronTrigger: vi.fn(async () => ({
            kind: "evaluated" as const,
            fire: true,
          })),
          runIsolatedAgentJob: vi.fn(async ({ job }) => {
            if (job.name === "error") {
              return { status: "error" as const, error: "provider overloaded" };
            }
            if (job.name === "timeout") {
              return { status: "error" as const, error: "cron: job execution timed out" };
            }
            if (job.name === "skipped") {
              return { status: "skipped" as const, error: "trigger condition not met" };
            }
            return {
              status: "ok" as const,
              summary: "delivered",
              delivered: true,
              deliveryAttempted: true,
              delivery: {
                intended: { channel: "telegram", to: "42" },
                resolved: { channel: "telegram", to: "42", ok: true },
                messageToolSentTo: [{ channel: "telegram", to: "42" }],
                delivered: true,
              },
              sessionId: "session-ok",
              sessionKey: "agent:main:cron:history:run:ok",
              model: "gpt-test",
              provider: "openai",
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            };
          }),
        });
        try {
          await cron.start();
          for (const name of ["ok", "error", "timeout", "skipped"]) {
            const job = await cron.add({
              name,
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              ...(name === "ok" ? { trigger: { script: "true" } } : {}),
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: name },
              delivery:
                name === "ok"
                  ? { mode: "announce", channel: "telegram", to: "42" }
                  : { mode: "none" },
            });
            if (name === "ok") {
              now = job.state.nextRunAtMs ?? now;
            }
            expect(await cron.run(job.id, name === "ok" ? "due" : "force")).toEqual({
              ok: true,
              ran: true,
            });
            now += 10_000;
          }
          const ledger = readCronTaskRunHistoryPage({
            storeKey: cronStoreKey(storePath),
            limit: 50,
            sortDir: "asc",
          });
          expect(ledger.entries.map((entry) => entry.status)).toEqual([
            "ok",
            "error",
            "error",
            "skipped",
          ]);
          expect(ledger.entries[0]).toMatchObject({
            deliveryStatus: "delivered",
            triggerFired: true,
            nextRunAtMs: expect.any(Number),
            model: "gpt-test",
            provider: "openai",
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          });
        } finally {
          cron.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });

  it("round-trips outcomes and telemetry through task detail", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-history-" },
      async (state) => {
        const storePath = state.path("jobs.json");
        const storeKey = cronStoreKey(storePath);
        const entries: CronRunLogEntry[] = [
          {
            ts: 1_100,
            jobId: JOB_ID,
            action: "finished",
            status: "ok",
            summary: "delivered\n  needle",
            diagnostics: {
              summary: "healthy",
              entries: [
                {
                  ts: 1_050,
                  source: "agent-run",
                  severity: "info",
                  message: "diagnostic needle",
                },
              ],
            },
            delivered: true,
            deliveryStatus: "delivered",
            failureNotificationDelivery: { status: "not-requested" },
            delivery: {
              intended: { channel: "telegram", to: "123" },
              resolved: { channel: "telegram", to: "123", ok: true },
              messageToolSentTo: [{ channel: "telegram", to: "123" }],
              delivered: true,
            },
            sessionId: "session-ok",
            sessionKey: "agent:main:cron:history:run:ok",
            runId: "manual:history:ok",
            runAtMs: 1_000,
            durationMs: 100,
            nextRunAtMs: 2_000,
            triggerFired: true,
            model: "gpt-test",
            provider: "openai",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              cache_read_tokens: 2,
              cache_write_tokens: 1,
            },
          },
          {
            ts: 2_250,
            jobId: JOB_ID,
            action: "finished",
            status: "error",
            error: "provider overloaded",
            errorReason: "overloaded",
            deliveryStatus: "not-delivered",
            deliveryError: "send failed",
            runId: "manual:history:error",
            runAtMs: 2_000,
            durationMs: 250,
            nextRunAtMs: 3_000,
            provider: "openai",
          },
          {
            ts: 3_500,
            jobId: JOB_ID,
            action: "finished",
            status: "error",
            error: "cron: job execution timed out",
            errorReason: "timeout",
            runId: "manual:history:timeout",
            runAtMs: 3_000,
            durationMs: 500,
            nextRunAtMs: 4_000,
          },
          {
            ts: 4_000,
            jobId: JOB_ID,
            action: "finished",
            status: "skipped",
            error: "trigger condition not met",
            summary: "",
            runId: "manual:history:skipped",
            runAtMs: 4_000,
            durationMs: 0,
            nextRunAtMs: 5_000,
          },
        ];
        saveTaskRegistryStateToSqlite({
          tasks: new Map(
            entries.map((entry, index) => [`task-${index}`, taskFromEntry(entry, index, storeKey)]),
          ),
          deliveryStates: new Map(),
        });
        const ledger = readCronTaskRunHistoryPage({ storeKey, jobId: JOB_ID, limit: 50 });
        const expected = entries
          .map((entry, index) => cronTaskRecordToRunLogEntry(taskFromEntry(entry, index, storeKey)))
          .toReversed();
        expect(ledger.entries).toEqual(expected);
        expect(ledger.entries.map((entry) => entry.status)).toEqual([
          "skipped",
          "error",
          "error",
          "ok",
        ]);
      },
    );
  });

  it("preserves paging and text-query filtering", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-history-page-" },
      async (state) => {
        const storeKey = cronStoreKey(state.path("jobs.json"));
        const entries: CronRunLogEntry[] = [
          {
            ts: 100,
            jobId: JOB_ID,
            action: "finished",
            status: "ok",
            summary: "first",
            runAtMs: 90,
            durationMs: 10,
          },
          {
            ts: 200,
            jobId: JOB_ID,
            action: "finished",
            status: "error",
            error: "needle failure",
            runAtMs: 180,
            durationMs: 20,
          },
          {
            ts: 300,
            jobId: JOB_ID,
            action: "finished",
            status: "skipped",
            summary: "third",
            runAtMs: 300,
            durationMs: 0,
          },
        ];
        saveTaskRegistryStateToSqlite({
          tasks: new Map([
            ...entries.map(
              (entry, index) => [`task-${index}`, taskFromEntry(entry, index, storeKey)] as const,
            ),
            ["future-detail", futureCronDetailTask(storeKey)] as const,
            [
              "other-store",
              {
                ...taskFromEntry(
                  {
                    ts: 250,
                    jobId: JOB_ID,
                    action: "finished",
                    status: "ok",
                    summary: "foreign partition",
                  },
                  5,
                  "/other/cron/store",
                ),
                taskId: "other-store",
              },
            ] as const,
            [
              "missing-store-key",
              {
                ...taskFromEntry(expectDefined(entries[0], "history entry"), 6, storeKey),
                taskId: "missing-store-key",
                detail: { kind: "cron-run", status: "ok" },
              },
            ] as const,
          ]),
          deliveryStates: new Map(),
        });

        expect(
          readCronTaskRunHistoryPage({ storeKey, jobId: JOB_ID, limit: 1, offset: 1 }),
        ).toMatchObject({
          entries: [expect.objectContaining({ ts: 200 })],
          total: 3,
          offset: 1,
          limit: 1,
          hasMore: true,
          nextOffset: 2,
        });
        expect(
          readCronTaskRunHistoryPage({
            storeKey,
            jobId: JOB_ID,
            query: "needle",
            status: "error",
            limit: 50,
          }).entries,
        ).toEqual([expect.objectContaining({ ts: 200, error: "needle failure" })]);
      },
    );
  });

  it("keeps same-job histories and totals scoped to one cron store", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-task-history-store-scope-" },
      async (state) => {
        const storeA = cronStoreKey(state.path("cron-a", "jobs.json"));
        const storeB = cronStoreKey(state.path("cron-b", "jobs.json"));
        const entryA: CronRunLogEntry = {
          ts: 100,
          jobId: JOB_ID,
          action: "finished",
          status: "ok",
          summary: "store a",
        };
        const entryB: CronRunLogEntry = {
          ts: 200,
          jobId: JOB_ID,
          action: "finished",
          status: "error",
          error: "store b",
        };
        saveTaskRegistryStateToSqlite({
          tasks: new Map([
            ["store-a", { ...taskFromEntry(entryA, 1, storeA), taskId: "store-a" }],
            ["store-b", { ...taskFromEntry(entryB, 2, storeB), taskId: "store-b" }],
          ]),
          deliveryStates: new Map(),
        });

        expect(readCronTaskRunHistoryPage({ storeKey: storeA, jobId: JOB_ID })).toMatchObject({
          entries: [expect.objectContaining({ summary: "store a" })],
          total: 1,
          hasMore: false,
        });
        expect(readCronTaskRunHistoryPage({ storeKey: storeB, jobId: JOB_ID })).toMatchObject({
          entries: [expect.objectContaining({ error: "store b" })],
          total: 1,
          hasMore: false,
        });
      },
    );
  });

  it("keeps the internal store key out of the legacy wire record", () => {
    const storeKey = "/internal/cron/store";
    const task = taskFromEntry(
      { ts: 100, jobId: JOB_ID, action: "finished", status: "ok" },
      1,
      storeKey,
    );
    const entry = cronTaskRecordToRunLogEntry(task);
    expect(entry).not.toBeNull();
    expect(Object.hasOwn(entry ?? {}, "storeKey")).toBe(false);
  });

  it("locks the serialized detail shape: kind first, status second", () => {
    // External tooling may prefix-match serialized detail; keep the codec's
    // field order stable so those prefixes stay meaningful.
    for (const status of ["ok", "error", "skipped"] as const) {
      const detail = cronRunLogEntryToTaskDetail(
        {
          ts: 100,
          jobId: JOB_ID,
          action: "finished",
          status,
        },
        { storeKey: "/tmp/cron-history" },
      );
      const serialized = JSON.stringify(detail);
      expect(
        serialized.startsWith(`{"kind":"cron-run","status":"${status}"`),
        `detail for status "${status}" must keep the stable prefix: ${serialized}`,
      ).toBe(true);
    }
  });

  it("authors failure reasons on write and trusts stored values on read", () => {
    const entry = cronRunLogEntryFromEvent(
      {
        jobId: JOB_ID,
        action: "finished",
        status: "error",
        error: "upstream unavailable: 503 overloaded",
      },
      1,
    );
    expect(entry.errorReason).toBe("overloaded");
    expect(parseCronRunLogEntryObject(entry)?.errorReason).toBe("overloaded");
    expect(
      parseCronRunLogEntryObject({
        ...entry,
        errorReason: "not-a-real-reason",
      })?.errorReason,
    ).toBeUndefined();
  });
});
