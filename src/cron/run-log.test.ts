import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyCronRunLogsToSqlite } from "../commands/doctor/cron/legacy-run-log-migration.js";
import {
  appendCronRunLog,
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  getPendingCronRunLogWriteCountForTests,
  readCronRunLogEntries,
  readCronRunLogEntriesPage,
  readCronRunLogEntriesSync,
  resolveCronRunLogPruneOptions,
} from "./run-log.js";

describe("cron run log", () => {
  it("resolves prune options from config with defaults", () => {
    expect(resolveCronRunLogPruneOptions()).toEqual({
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
    });
    expect(
      resolveCronRunLogPruneOptions({
        maxBytes: "5mb",
        keepLines: 123,
      }),
    ).toEqual({
      maxBytes: 5 * 1024 * 1024,
      keepLines: 123,
    });
    expect(
      resolveCronRunLogPruneOptions({
        maxBytes: "invalid",
        keepLines: -1,
      }),
    ).toEqual({
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
    });
  });

  async function withRunLogDir(prefix: string, run: (dir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  function storePathForDir(dir: string): string {
    return path.join(dir, "jobs.json");
  }

  it("rejects unsafe job ids before querying SQLite run logs", async () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    for (const jobId of ["../job-1", "nested/job-1", "..\\job-1"]) {
      await expect(readCronRunLogEntriesPage({ storePath, jobId })).rejects.toThrow(
        /invalid cron run log job id/i,
      );
    }
  });

  it("appends SQLite rows and prunes by line count", async () => {
    await withRunLogDir("openclaw-cron-log-", async (dir) => {
      const storePath = storePathForDir(dir);

      for (let i = 0; i < 10; i++) {
        await appendCronRunLog({
          storePath,
          entry: {
            ts: 1000 + i,
            jobId: "job-1",
            action: "finished",
            status: "ok",
            durationMs: i,
          },
          opts: { keepLines: 3 },
        });
      }

      const entries = readCronRunLogEntriesSync({ storePath, jobId: "job-1", limit: 10 });
      expect(entries.map((entry) => entry.ts)).toEqual([1007, 1008, 1009]);
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await expect(fs.stat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reads run-log entries synchronously for task reconciliation", async () => {
    await withRunLogDir("openclaw-cron-log-sync-", async (dir) => {
      const storePath = storePathForDir(dir);
      await appendCronRunLog({
        storePath,
        entry: {
          ts: 1000,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          runAtMs: 900,
          durationMs: 100,
        },
      });
      await appendCronRunLog({
        storePath,
        entry: {
          ts: 2000,
          jobId: "job-2",
          action: "finished",
          status: "error",
        },
      });

      const jobEntries = readCronRunLogEntriesSync({ storePath, jobId: "job-1" });
      expect(jobEntries).toHaveLength(1);
      expect(jobEntries[0]?.jobId).toBe("job-1");
      expect(jobEntries[0]?.status).toBe("ok");
      expect(jobEntries[0]?.runAtMs).toBe(900);
      expect(jobEntries[0]?.durationMs).toBe(100);
      expect(readCronRunLogEntriesSync({ storePath, jobId: "missing" })).toStrictEqual([]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not create legacy run log files for new writes",
    async () => {
      await withRunLogDir("openclaw-cron-log-perms-", async (dir) => {
        const storePath = storePathForDir(dir);
        const logPath = path.join(dir, "runs", "job-1.jsonl");

        await appendCronRunLog({
          storePath,
          entry: {
            ts: 1,
            jobId: "job-1",
            action: "finished",
            status: "ok",
          },
        });

        await expect(fs.stat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not mutate legacy run-log directory permissions on SQLite writes",
    async () => {
      await withRunLogDir("openclaw-cron-log-dir-perms-", async (dir) => {
        const storePath = storePathForDir(dir);
        const runDir = path.join(dir, "runs");
        await fs.mkdir(runDir, { recursive: true, mode: 0o755 });
        await fs.chmod(runDir, 0o755);

        await appendCronRunLog({
          storePath,
          entry: {
            ts: 1,
            jobId: "job-1",
            action: "finished",
            status: "ok",
          },
        });

        const runDirMode = (await fs.stat(runDir)).mode & 0o777;
        expect(runDirMode).toBe(0o755);
      });
    },
  );

  it("reads newest entries and filters by jobId", async () => {
    await withRunLogDir("openclaw-cron-log-read-", async (dir) => {
      const storePath = storePathForDir(dir);

      await appendCronRunLog({
        storePath,
        entry: { ts: 1, jobId: "a", action: "finished", status: "ok" },
      });
      await appendCronRunLog({
        storePath,
        entry: {
          ts: 2,
          jobId: "b",
          action: "finished",
          status: "error",
          error: "nope",
          summary: "oops",
        },
      });
      await appendCronRunLog({
        storePath,
        entry: {
          ts: 3,
          jobId: "a",
          action: "finished",
          status: "skipped",
          sessionId: "run-123",
          sessionKey: "agent:main:cron:a:run:run-123",
        },
      });

      const allA = await readCronRunLogEntries({ storePath, jobId: "a", limit: 10 });
      expect(allA.map((e) => e.jobId)).toEqual(["a", "a"]);

      const onlyA = await readCronRunLogEntries({
        storePath,
        limit: 10,
        jobId: "a",
      });
      expect(onlyA.map((e) => e.ts)).toEqual([1, 3]);

      const lastOne = await readCronRunLogEntries({ storePath, jobId: "a", limit: 1 });
      expect(lastOne.map((e) => e.ts)).toEqual([3]);
      expect(lastOne[0]?.sessionId).toBe("run-123");
      expect(lastOne[0]?.sessionKey).toBe("agent:main:cron:a:run:run-123");

      const onlyB = await readCronRunLogEntries({
        storePath,
        limit: 10,
        jobId: "b",
      });
      expect(onlyB[0]?.summary).toBe("oops");

      expect(await readCronRunLogEntries({ storePath, limit: 10, jobId: "missing" })).toStrictEqual(
        [],
      );
    });
  });

  it("filters run-log pages by runId", async () => {
    await withRunLogDir("openclaw-cron-log-runid-", async (dir) => {
      const storePath = storePathForDir(dir);

      await appendCronRunLog({
        storePath,
        entry: {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "error",
          runId: "manual:job-1:1:0",
        },
      });
      await appendCronRunLog({
        storePath,
        entry: {
          ts: 2,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          runId: "manual:job-1:2:0",
        },
      });

      const page = await readCronRunLogEntriesPage({
        storePath,
        jobId: "job-1",
        runId: "manual:job-1:2:0",
        limit: 10,
      });

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.runId).toBe("manual:job-1:2:0");
      expect(page.entries[0]?.status).toBe("ok");
    });
  });

  it("ignores invalid and non-finished lines while preserving delivery fields", async () => {
    await withRunLogDir("openclaw-cron-log-filter-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        [
          '{"bad":',
          JSON.stringify({ ts: 1, jobId: "job-1", action: "started", status: "ok" }),
          JSON.stringify({
            ts: 2,
            jobId: "job-1",
            action: "finished",
            status: "ok",
            delivered: true,
            deliveryStatus: "not-delivered",
            deliveryError: "announce failed",
            failureNotificationDelivery: {
              delivered: true,
              status: "delivered",
            },
            delivery: {
              intended: { channel: "last", to: null, source: "last" },
              resolved: { ok: true, channel: "telegram", to: "-100", source: "last" },
              messageToolSentTo: [{ channel: "telegram", to: "-100" }],
              fallbackUsed: false,
              delivered: true,
            },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const storePath = storePathForDir(dir);
      await migrateLegacyCronRunLogsToSqlite(storePath);
      const entries = await readCronRunLogEntries({ storePath, limit: 10, jobId: "job-1" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(2);
      expect(entries[0]?.delivered).toBe(true);
      expect(entries[0]?.deliveryStatus).toBe("not-delivered");
      expect(entries[0]?.deliveryError).toBe("announce failed");
      expect(entries[0]?.failureNotificationDelivery).toEqual({
        delivered: true,
        status: "delivered",
      });
      expect(entries[0]?.delivery).toEqual({
        intended: { channel: "last", to: null, source: "last" },
        resolved: { ok: true, channel: "telegram", to: "-100", source: "last" },
        messageToolSentTo: [{ channel: "telegram", to: "-100" }],
        fallbackUsed: false,
        delivered: true,
      });
    });
  });

  it("dedupes legacy migration against all existing SQLite rows when archive is blocked", async () => {
    await withRunLogDir("openclaw-cron-log-large-migration-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      const lines = Array.from({ length: 5001 }, (_value, index) =>
        JSON.stringify({
          ts: index + 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          runId: `run-${index + 1}`,
        }),
      );
      await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf-8");
      await fs.writeFile(`${logPath}.migrated`, "", "utf-8");

      const storePath = storePathForDir(dir);
      await migrateLegacyCronRunLogsToSqlite(storePath);
      await migrateLegacyCronRunLogsToSqlite(storePath);

      const page = await readCronRunLogEntriesPage({
        storePath,
        jobId: "job-1",
        limit: 1,
      });
      expect(page.total).toBe(5001);
    });
  });

  it("does not include raw delivery targets in run-log search", async () => {
    await withRunLogDir("openclaw-cron-log-target-query-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        JSON.stringify({
          ts: 2,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          summary: "done",
          delivery: {
            intended: { channel: "last", to: null, source: "last" },
            resolved: { ok: true, channel: "telegram", to: "-100", source: "last" },
            messageToolSentTo: [{ channel: "telegram", to: "-100" }],
          },
        }) + "\n",
        "utf-8",
      );

      const storePath = storePathForDir(dir);
      await migrateLegacyCronRunLogsToSqlite(storePath);
      expect(
        (
          await readCronRunLogEntriesPage({
            storePath,
            limit: 10,
            jobId: "job-1",
            query: "telegram",
          })
        ).entries,
      ).toHaveLength(1);
      expect(
        (
          await readCronRunLogEntriesPage({
            storePath,
            limit: 10,
            jobId: "job-1",
            query: "-100",
          })
        ).entries,
      ).toStrictEqual([]);
    });
  });

  it("reads and searches run diagnostics", async () => {
    await withRunLogDir("openclaw-cron-log-diagnostics-", async (dir) => {
      const storePath = storePathForDir(dir);

      await appendCronRunLog({
        storePath,
        entry: {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "error",
          diagnostics: {
            summary: "exec stderr tail",
            entries: [
              {
                ts: 1,
                source: "exec",
                severity: "error",
                message: "exec stderr tail",
                exitCode: 2,
              },
            ],
          },
        },
      });

      const entries = await readCronRunLogEntries({ storePath, limit: 10, jobId: "job-1" });
      expect(entries[0]?.diagnostics?.summary).toBe("exec stderr tail");
      expect(entries[0]?.diagnostics?.entries).toHaveLength(1);
      expect(entries[0]?.diagnostics?.entries[0]?.source).toBe("exec");
      expect(entries[0]?.diagnostics?.entries[0]?.severity).toBe("error");
      expect(entries[0]?.diagnostics?.entries[0]?.message).toBe("exec stderr tail");
      expect(entries[0]?.diagnostics?.entries[0]?.exitCode).toBe(2);
      expect(
        (
          await readCronRunLogEntriesPage({
            storePath,
            limit: 10,
            jobId: "job-1",
            query: "stderr tail",
          })
        ).entries,
      ).toHaveLength(1);
    });
  });

  it("reads telemetry fields", async () => {
    await withRunLogDir("openclaw-cron-log-telemetry-", async (dir) => {
      const storePath = storePathForDir(dir);
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      await appendCronRunLog({
        storePath,
        entry: {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          model: "gpt-5.4",
          provider: "openai",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            cache_read_tokens: 2,
            cache_write_tokens: 1,
          },
        },
      });

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(
        logPath,
        `${JSON.stringify({
          ts: 2,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          model: " ",
          provider: "",
          usage: { input_tokens: "oops" },
        })}\n`,
        "utf-8",
      );

      await migrateLegacyCronRunLogsToSqlite(storePath);
      const entries = await readCronRunLogEntries({ storePath, limit: 10, jobId: "job-1" });
      expect(entries[0]?.model).toBe("gpt-5.4");
      expect(entries[0]?.provider).toBe("openai");
      expect(entries[0]?.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cache_read_tokens: 2,
        cache_write_tokens: 1,
      });
      expect(entries[1]?.model).toBeUndefined();
      expect(entries[1]?.provider).toBeUndefined();
      expect(entries[1]?.usage?.input_tokens).toBeUndefined();
    });
  });

  it("cleans up pending-write bookkeeping after appends complete", async () => {
    await withRunLogDir("openclaw-cron-log-pending-", async (dir) => {
      await appendCronRunLog({
        storePath: storePathForDir(dir),
        entry: {
          ts: 1,
          jobId: "job-cleanup",
          action: "finished",
          status: "ok",
        },
      });

      expect(getPendingCronRunLogWriteCountForTests()).toBe(0);
    });
  });

  it("read drains pending fire-and-forget writes", async () => {
    await withRunLogDir("openclaw-cron-log-drain-", async (dir) => {
      const storePath = storePathForDir(dir);

      // Fire-and-forget write (simulates the `void appendCronRunLog(...)` pattern
      // in server-cron.ts). Do NOT await.
      const writePromise = appendCronRunLog({
        storePath,
        entry: {
          ts: 42,
          jobId: "job-drain",
          action: "finished",
          status: "ok",
          summary: "drain-test",
        },
      });
      void writePromise.catch(() => undefined);

      // Read should see the entry because it drains pending writes.
      const entries = await readCronRunLogEntries({ storePath, jobId: "job-drain", limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(42);
      expect(entries[0]?.summary).toBe("drain-test");

      // Clean up
      await writePromise.catch(() => undefined);
    });
  });

  it("stamps jobNameById onto single-job page entries", async () => {
    await withRunLogDir("openclaw-cron-log-jobname-", async (dir) => {
      const storePath = storePathForDir(dir);
      for (const entry of [
        {
          ts: 1,
          jobId: "job-rename",
          action: "finished" as const,
          status: "ok" as const,
          runId: "manual:job-rename:1:0",
        },
        {
          ts: 2,
          jobId: "job-rename",
          action: "finished" as const,
          status: "error" as const,
          runId: "manual:job-rename:2:0",
        },
      ]) {
        await appendCronRunLog({
          storePath,
          entry,
        });
      }

      const withoutName = await readCronRunLogEntriesPage({
        storePath,
        limit: 10,
        jobId: "job-rename",
        sortDir: "asc",
      });
      expect(withoutName.entries).toHaveLength(2);
      for (const entry of withoutName.entries) {
        expect((entry as { jobName?: string }).jobName).toBeUndefined();
      }

      const withName = await readCronRunLogEntriesPage({
        storePath,
        limit: 10,
        jobId: "job-rename",
        jobNameById: { "job-rename": "Current Name" },
        sortDir: "asc",
      });
      expect(withName.entries).toHaveLength(2);
      for (const entry of withName.entries) {
        expect((entry as { jobName?: string }).jobName).toBe("Current Name");
      }
    });
  });
});
