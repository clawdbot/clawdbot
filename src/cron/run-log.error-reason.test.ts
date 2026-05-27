import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCronRunLogEntriesPage } from "./run-log.js";

describe("cron run log errorReason", () => {
  it("backfills errorReason from timeout error text for older entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "cron: job execution timed out",
      })}\n`,
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 10 });
    expect(page.entries[0]?.errorReason).toBe("timeout");
  });

  it("validates persisted errorReason against the full failover reason set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
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
    ];
    await fs.writeFile(
      file,
      reasons
        .map((errorReason, index) =>
          JSON.stringify({
            ts: index + 1,
            jobId: "job-1",
            action: "finished",
            status: "error",
            errorReason,
          }),
        )
        .join("\n") + "\n",
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 50, sortDir: "asc" });
    expect(page.entries.map((entry) => entry.errorReason)).toEqual(reasons);
  });

  it("derives an invalid persisted reason from raw error text before exposing entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "upstream unavailable: 503 overloaded",
        errorReason: "not-a-real-reason",
      })}\n`,
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 10 });
    expect(page.entries[0]?.errorReason).toBe("overloaded");
  });

  it("uses provider context when deriving persisted run-log reasons", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "403 Key limit exceeded (monthly limit)",
        provider: "openrouter",
      })}\n`,
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 10 });
    expect(page.entries[0]?.errorReason).toBe("billing");
  });

  it("includes derived errorReason values in run-log search", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "cron: job execution timed out",
      })}\n`,
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 10, query: "timeout" });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.errorReason).toBe("timeout");
  });
});
