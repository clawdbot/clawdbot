import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendCronRunLog,
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  getPendingCronRunLogWriteCountForTests,
  readCronRunLogEntries,
  readCronRunLogEntriesPage,
  readCronRunLogEntriesSync,
  resolveCronRunLogPruneOptions,
  resolveCronRunLogPath,
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

  it("resolves store path to per-job runs/<jobId>.jsonl", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    const p = resolveCronRunLogPath({ storePath, jobId: "job-1" });
    expect(p.endsWith(path.join(os.tmpdir(), "cron", "runs", "job-1.jsonl"))).toBe(true);
  });

  it("rejects unsafe job ids when resolving run log path", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    expect(() => resolveCronRunLogPath({ storePath, jobId: "../job-1" })).toThrow(
      /invalid cron run log job id/i,
    );
    expect(() => resolveCronRunLogPath({ storePath, jobId: "nested/job-1" })).toThrow(
      /invalid cron run log job id/i,
    );
    expect(() => resolveCronRunLogPath({ storePath, jobId: "..\\job-1" })).toThrow(
      /invalid cron run log job id/i,
    );
  });

  it("appends JSONL and prunes by line count", async () => {
    await withRunLogDir("openclaw-cron-log-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      for (let i = 0; i < 10; i++) {
        await appendCronRunLog(
          logPath,
          {
            ts: 1000 + i,
            jobId: "job-1",
            action: "finished",
            status: "ok",
            durationMs: i,
          },
          { maxBytes: 1, keepLines: 3 },
        );
      }

      const raw = await fs.readFile(logPath, "utf-8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.length).toBe(3);
      const last = JSON.parse(lines[2] ?? "{}") as { ts?: number };
      expect(last.ts).toBe(1009);
    });
  });

  it("reads run-log entries synchronously for task reconciliation", async () => {
    await withRunLogDir("openclaw-cron-log-sync-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");
      await appendCronRunLog(logPath, {
        ts: 1000,
        jobId: "job-1",
        action: "finished",
        status: "ok",
        runAtMs: 900,
        durationMs: 100,
      });
      await appendCronRunLog(logPath, {
        ts: 2000,
        jobId: "job-2",
        action: "finished",
        status: "error",
      });

      expect(readCronRunLogEntriesSync(logPath, { jobId: "job-1" })).toEqual([
        expect.objectContaining({
          jobId: "job-1",
          status: "ok",
          runAtMs: 900,
          durationMs: 100,
        }),
      ]);
      expect(readCronRunLogEntriesSync(path.join(dir, "runs", "missing.jsonl"))).toEqual([]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "writes run log files with secure permissions",
    async () => {
      await withRunLogDir("openclaw-cron-log-perms-", async (dir) => {
        const logPath = path.join(dir, "runs", "job-1.jsonl");

        await appendCronRunLog(logPath, {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
        });

        const mode = (await fs.stat(logPath)).mode & 0o777;
        expect(mode).toBe(0o600);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "hardens an existing run-log directory to owner-only permissions",
    async () => {
      await withRunLogDir("openclaw-cron-log-dir-perms-", async (dir) => {
        const runDir = path.join(dir, "runs");
        const logPath = path.join(runDir, "job-1.jsonl");
        await fs.mkdir(runDir, { recursive: true, mode: 0o755 });
        await fs.chmod(runDir, 0o755);

        await appendCronRunLog(logPath, {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
        });

        const runDirMode = (await fs.stat(runDir)).mode & 0o777;
        expect(runDirMode).toBe(0o700);
      });
    },
  );

  it("reads newest entries and filters by jobId", async () => {
    await withRunLogDir("openclaw-cron-log-read-", async (dir) => {
      const logPathA = path.join(dir, "runs", "a.jsonl");
      const logPathB = path.join(dir, "runs", "b.jsonl");

      await appendCronRunLog(logPathA, {
        ts: 1,
        jobId: "a",
        action: "finished",
        status: "ok",
      });
      await appendCronRunLog(logPathB, {
        ts: 2,
        jobId: "b",
        action: "finished",
        status: "error",
        error: "nope",
        summary: "oops",
      });
      await appendCronRunLog(logPathA, {
        ts: 3,
        jobId: "a",
        action: "finished",
        status: "skipped",
        sessionId: "run-123",
        sessionKey: "agent:main:cron:a:run:run-123",
      });

      const allA = await readCronRunLogEntries(logPathA, { limit: 10 });
      expect(allA.map((e) => e.jobId)).toEqual(["a", "a"]);

      const onlyA = await readCronRunLogEntries(logPathA, {
        limit: 10,
        jobId: "a",
      });
      expect(onlyA.map((e) => e.ts)).toEqual([1, 3]);

      const lastOne = await readCronRunLogEntries(logPathA, { limit: 1 });
      expect(lastOne.map((e) => e.ts)).toEqual([3]);
      expect(lastOne[0]?.sessionId).toBe("run-123");
      expect(lastOne[0]?.sessionKey).toBe("agent:main:cron:a:run:run-123");

      const onlyB = await readCronRunLogEntries(logPathB, {
        limit: 10,
        jobId: "b",
      });
      expect(onlyB[0]?.summary).toBe("oops");

      const wrongFilter = await readCronRunLogEntries(logPathA, {
        limit: 10,
        jobId: "b",
      });
      expect(wrongFilter).toEqual([]);
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

      const entries = await readCronRunLogEntries(logPath, { limit: 10, jobId: "job-1" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(2);
      expect(entries[0]?.delivered).toBe(true);
      expect(entries[0]?.deliveryStatus).toBe("not-delivered");
      expect(entries[0]?.deliveryError).toBe("announce failed");
      expect(entries[0]?.delivery).toEqual({
        intended: { channel: "last", to: null, source: "last" },
        resolved: { ok: true, channel: "telegram", to: "-100", source: "last" },
        messageToolSentTo: [{ channel: "telegram", to: "-100" }],
        fallbackUsed: false,
        delivered: true,
      });
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

      expect(
        (
          await readCronRunLogEntriesPage(logPath, {
            limit: 10,
            jobId: "job-1",
            query: "telegram",
          })
        ).entries,
      ).toHaveLength(1);
      expect(
        (
          await readCronRunLogEntriesPage(logPath, {
            limit: 10,
            jobId: "job-1",
            query: "-100",
          })
        ).entries,
      ).toEqual([]);
    });
  });

  it("reads telemetry fields", async () => {
    await withRunLogDir("openclaw-cron-log-telemetry-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-1.jsonl");

      await appendCronRunLog(logPath, {
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
      });

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

      const entries = await readCronRunLogEntries(logPath, { limit: 10, jobId: "job-1" });
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
      const logPath = path.join(dir, "runs", "job-cleanup.jsonl");
      await appendCronRunLog(logPath, {
        ts: 1,
        jobId: "job-cleanup",
        action: "finished",
        status: "ok",
      });

      expect(getPendingCronRunLogWriteCountForTests()).toBe(0);
    });
  });

  it("read drains pending fire-and-forget writes", async () => {
    await withRunLogDir("openclaw-cron-log-drain-", async (dir) => {
      const logPath = path.join(dir, "runs", "job-drain.jsonl");

      // Fire-and-forget write (simulates the `void appendCronRunLog(...)` pattern
      // in server-cron.ts). Do NOT await.
      const writePromise = appendCronRunLog(logPath, {
        ts: 42,
        jobId: "job-drain",
        action: "finished",
        status: "ok",
        summary: "drain-test",
      });
      void writePromise.catch(() => undefined);

      // Read should see the entry because it drains pending writes.
      const entries = await readCronRunLogEntries(logPath, { limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ts).toBe(42);
      expect(entries[0]?.summary).toBe("drain-test");

      // Clean up
      await writePromise.catch(() => undefined);
    });
  });
});
