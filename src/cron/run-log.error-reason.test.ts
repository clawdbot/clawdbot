import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyCronRunLogsToSqlite } from "../commands/doctor/cron/legacy-run-log-migration.js";
import { appendCronRunLog, readCronRunLogEntriesPage, type CronRunLogEntry } from "./run-log.js";

async function writeLegacyRunLogAndMigrate(
  entries: Array<Record<string, unknown>>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
  const storePath = path.join(dir, "cron", "jobs.json");
  const file = path.join(dir, "cron", "runs", "job-1.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  await migrateLegacyCronRunLogsToSqlite(storePath);
  return file;
}

function fileToStorePath(file: string): string {
  return path.join(path.dirname(path.dirname(file)), "jobs.json");
}

describe("cron run log errorReason", () => {
  it("backfills errorReason from timeout error text for older entries", async () => {
    const file = await writeLegacyRunLogAndMigrate([
      {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "cron: job execution timed out",
      },
    ]);

    const page = await readCronRunLogEntriesPage({
      storePath: fileToStorePath(file),
      jobId: "job-1",
      limit: 10,
    });
    expect(page.entries[0]?.errorReason).toBe("timeout");
  });

  it("validates persisted errorReason against the full failover reason set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const storePath = path.join(dir, "jobs.json");
    const reasons = [
      "auth",
      "auth_permanent",
      "format",
      "rate_limit",
      "overloaded",
      "billing",
      "server_error",
      "timeout",
      "model_not_found",
      "session_expired",
      "empty_response",
      "no_error_details",
      "unclassified",
      "unknown",
    ] satisfies Array<NonNullable<CronRunLogEntry["errorReason"]>>;
    for (const [index, errorReason] of reasons.entries()) {
      await appendCronRunLog({
        storePath,
        entry: {
          ts: index + 1,
          jobId: "job-1",
          action: "finished",
          status: "error",
          errorReason,
        },
      });
    }

    const page = await readCronRunLogEntriesPage({
      storePath,
      jobId: "job-1",
      limit: 50,
      sortDir: "asc",
    });
    expect(page.entries.map((entry) => entry.errorReason)).toEqual(reasons);
  });

  it("derives an invalid persisted reason from raw error text before exposing entries", async () => {
    const file = await writeLegacyRunLogAndMigrate([
      {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "upstream unavailable: 503 overloaded",
        errorReason: "not-a-real-reason",
      },
    ]);

    const page = await readCronRunLogEntriesPage({
      storePath: fileToStorePath(file),
      jobId: "job-1",
      limit: 10,
    });
    expect(page.entries[0]?.errorReason).toBe("overloaded");
  });

  it("uses provider context when deriving persisted run-log reasons", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const storePath = path.join(dir, "jobs.json");
    await appendCronRunLog({
      storePath,
      entry: {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "403 Key limit exceeded (monthly limit)",
        provider: "openrouter",
      },
    });

    const page = await readCronRunLogEntriesPage({ storePath, jobId: "job-1", limit: 10 });
    expect(page.entries[0]?.errorReason).toBe("billing");
  });

  it("includes derived errorReason values in run-log search", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const storePath = path.join(dir, "jobs.json");
    await appendCronRunLog({
      storePath,
      entry: {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "cron: job execution timed out",
      },
    });

    const page = await readCronRunLogEntriesPage({
      storePath,
      jobId: "job-1",
      limit: 10,
      query: "timeout",
    });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.errorReason).toBe("timeout");
  });
});
