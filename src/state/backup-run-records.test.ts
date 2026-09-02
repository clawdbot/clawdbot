import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBackupStatusValue,
  noteBackupDoctorHint,
  readBackupFreshness,
} from "../commands/backup-health.js";
import { recordBackupRunOutcome } from "./backup-run-records.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const roots: string[] = [];
const mocks = vi.hoisted(() => ({ note: vi.fn() }));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

async function testEnv(options?: { bootstrap?: boolean }): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-runs-test-"));
  roots.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  if (options?.bootstrap) {
    // Recording is non-creating by contract, so the fixture bootstraps the
    // state database the way a real gateway host already has.
    runOpenClawStateWriteTransaction(() => undefined, { env });
  }
  return env;
}

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.note.mockReset();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("backup run records", () => {
  it("records archive and Git outcomes and prunes the operational log to 200 rows", async () => {
    const env = await testEnv({ bootstrap: true });
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
        pushFailed: index === 202,
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
      pushFailed: true,
    });
    expect(readBackupFreshness(env)).toMatchObject({
      latest: { createdAt: 202, pushFailed: true },
      latestOk: { createdAt: 202, pushFailed: true },
    });
  });

  it("treats an older same-version database without backup_runs as no recorded backups", async () => {
    const env = await testEnv({ bootstrap: true });
    withExistingOpenClawStateDatabaseReadOnly(() => undefined, { env });
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    raw.exec("DROP TABLE backup_runs");
    raw.close();
    expect(readBackupFreshness(env)).toEqual({});
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
    noteBackupDoctorHint(env);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("No successful backup is recorded."),
      "Backups",
    );

    // Recording is non-creating; bootstrap the state database before the
    // recording phase the way a real gateway host already has.
    runOpenClawStateWriteTransaction(() => undefined, { env });
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    recordBackupRunOutcome({
      env,
      archivePath: "/backup",
      status: "ok",
      kind: "git",
      createdAt: 1,
    });
    mocks.note.mockClear();
    noteBackupDoctorHint(env);
    expect(mocks.note).not.toHaveBeenCalled();

    vi.mocked(Date.now).mockReturnValue(1 + 15 * 24 * 3_600_000);
    noteBackupDoctorHint(env);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("more than 14 days old"),
      "Backups",
    );

    recordBackupRunOutcome({
      env,
      archivePath: "/backups/git",
      status: "ok",
      kind: "git",
      pushFailed: true,
      createdAt: 2,
    });
    const pushFailed = readBackupFreshness(env);
    expect(
      buildBackupStatusValue({
        freshness: pushFailed,
        now: 3_600_002,
        formatTimeAgo,
      }),
    ).toBe("last ok 1h ago (git, push failing)");
    mocks.note.mockClear();
    vi.mocked(Date.now).mockReturnValue(3_600_002);
    noteBackupDoctorHint(env);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringMatching(/configured Git remote.*\/backups\/git/su),
      "Backups",
    );
  });
});
