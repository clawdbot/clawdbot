import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBackupDoctorHint,
  buildBackupStatusValue,
  readBackupFreshness,
} from "../commands/backup-health.js";
import { recordBackupRunOutcome } from "./backup-run-records.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const roots: string[] = [];

async function testEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-runs-test-"));
  roots.push(root);
  return { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("backup run records", () => {
  it("records archive and Git outcomes and prunes the operational log to 200 rows", async () => {
    const env = await testEnv();
    recordBackupRunOutcome({
      env,
      archivePath: "/backups/archive.tar.gz",
      status: "failed",
      kind: "archive",
      error: "archive failed",
      createdAt: 1,
    });
    for (let index = 2; index <= 202; index += 1) {
      recordBackupRunOutcome({
        env,
        archivePath: "/backups/git",
        status: "ok",
        kind: "git",
        target: `commit-${index}`,
        createdAt: index,
      });
    }
    const rows = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        db
          .prepare(
            "SELECT created_at, status, manifest_json FROM backup_runs ORDER BY created_at ASC",
          )
          .all() as Array<{ created_at: number; status: string; manifest_json: string }>,
      { env },
    );
    expect(rows).toHaveLength(200);
    expect(rows?.[0]?.created_at).toBe(3);
    expect(rows?.at(-1)).toMatchObject({ created_at: 202, status: "ok" });
    expect(JSON.parse(rows?.at(-1)?.manifest_json ?? "{}")).toMatchObject({
      kind: "git",
      target: "commit-202",
    });
  });

  it("keeps absent status reads read-only and formats none, failed, fresh, and stale states", async () => {
    const env = await testEnv();
    expect(readBackupFreshness(env)).toEqual({});
    await expect(fs.access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const formatTimeAgo = (ageMs: number) => `${ageMs / 3_600_000}h ago`;
    expect(buildBackupStatusValue({ freshness: {}, now: 10, formatTimeAgo })).toBe("none recorded");
    const failed = {
      id: "failed",
      createdAt: 1,
      archivePath: "/backup",
      status: "failed" as const,
      kind: "archive" as const,
    };
    expect(
      buildBackupStatusValue({
        freshness: { latest: failed },
        now: 3 * 24 * 3_600_000 + 1,
        formatTimeAgo,
      }),
    ).toBe("last attempt failed 72h ago (archive)");
    const fresh = { ...failed, id: "ok", status: "ok" as const, kind: "git" as const };
    expect(
      buildBackupDoctorHint({ freshness: { latest: fresh, latestOk: fresh }, now: 1_000 }),
    ).toBeNull();
    expect(buildBackupDoctorHint({ freshness: {}, now: 1_000 })).toContain(
      "No successful backup is recorded.",
    );
    expect(
      buildBackupDoctorHint({
        freshness: { latest: fresh, latestOk: fresh },
        now: fresh.createdAt + 15 * 24 * 3_600_000,
      }),
    ).toContain("more than 14 days old");
  });
});
