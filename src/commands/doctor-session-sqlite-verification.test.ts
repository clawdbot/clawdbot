// Regression tests for the recovery destination verifier. Sidecar files (WAL/SHM/journal)
// can have ctime/mtime/size churn from read-only queries; only their identity (dev/ino)
// is fenced. The main database file is fully fenced so substantive writes are still
// detected after a WAL checkpoint. (#140467)
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { SessionSqliteMigrationTargetManifest } from "./doctor-session-sqlite-migration-run.js";
import { createRecoveryDestinationVerifier } from "./doctor-session-sqlite-verification.js";

const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeMinimalTargetManifest(
  sqlitePath: string,
  agentId: string,
): SessionSqliteMigrationTargetManifest {
  return {
    agentId,
    sqlitePath,
    storePath: path.dirname(sqlitePath),
    completedMoves: [],
    issues: [],
    plannedMoves: [],
    validationBeforeArchive: "not_run",
  };
}

describe("createRecoveryDestinationVerifier", () => {
  let stateDir: string;
  let agentId: string;
  let sqlitePath: string;

  beforeEach(() => {
    stateDir = autoCleanupTempDirs.make("verification-");
    agentId = "test-agent";
    sqlitePath = resolveOpenClawAgentSqlitePath({
      agentId,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const db = openOpenClawAgentDatabase({
      agentId,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    // Force WAL/SHM files to exist by writing a row then checkpointing.
    db.db.exec(
      `CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY);
       INSERT INTO probe (id) VALUES (1);`,
    );
    db.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    // Reopen to recreate WAL/SHM, then leave them in place after close.
    db.db.exec("INSERT INTO probe (id) VALUES (2);");
    closeOpenClawAgentDatabasesForTest();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("does not throw when a sidecar file's ctime/mtime changes from a read-only query", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    // Establish baseline.
    verify([{ target }]);

    // Simulate a read-only query touching SHM state by advancing the SHM file's
    // mtime/ctime well past the baseline.  Only the SHM file (index 2) is exempt from
    // ctime/mtime fencing — read-only queries update SHM read marks. The WAL (index 1)
    // and rollback journal (index 3) are still fully fenced. (#140467)
    const shmPath = resolveSqliteDatabaseFilePaths(sqlitePath)[2]!;
    const future = new Date((Date.now() / 1000) * 1000 + 60_000);
    if (fs.existsSync(shmPath)) {
      fs.utimesSync(shmPath, future, future);
    }

    // Should NOT throw — SHM dev/ino/size are unchanged, only ctime/mtime churned.
    expect(() => verify([{ target }])).not.toThrow();
  });

  it("throws when the main database file's mtime changes (substantive write)", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    // Establish baseline.
    verify([{ target }]);

    // Simulate a substantive write to the main database file.
    const future = new Date((Date.now() / 1000) * 1000 + 60_000);
    fs.utimesSync(sqlitePath, future, future);

    // SHOULD throw — main DB (index 0) is fully fenced.
    expect(() => verify([{ target }])).toThrow(
      "Recovery destination database changed; preview cleanup again.",
    );
  });

  it("throws when a sidecar file is deleted after baseline (identity loss)", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    // Ensure a WAL sidecar exists before baseline so the fallback path is deterministic.
    const walPath = `${sqlitePath}-wal`;
    if (!fs.existsSync(walPath)) {
      fs.writeFileSync(walPath, Buffer.alloc(32));
    }

    // Establish baseline with the WAL present.
    verify([{ target }]);

    // Delete the sidecar that existed in the baseline. The verifier should detect the
    // identity change (dev/ino now undefined vs. recorded BigInt). (#140467)
    fs.unlinkSync(walPath);
    expect(() => verify([{ target }])).toThrow(
      "Recovery destination database changed; preview cleanup again.",
    );
  });

  it("throws when a sidecar file's size changes (substantive WAL commit)", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    // Establish baseline.
    verify([{ target }]);

    // Grow the WAL sidecar file (simulates a substantive WAL commit that appends frames).
    // The verifier should detect the size change on the sidecar even though ctime/mtime are
    // excluded, because substantive writes must still be caught. (#140467)
    const walPath = `${sqlitePath}-wal`;
    const initial = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
    fs.writeFileSync(walPath, Buffer.alloc(initial.length + 4096));

    // SHOULD throw — WAL size changed (substantive write is still fenced).
    expect(() => verify([{ target }])).toThrow(
      "Recovery destination database changed; preview cleanup again.",
    );
  });

  it("throws when the WAL file's content changes at the same size (same-size WAL commit)", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    // Ensure a WAL sidecar exists with a known payload before baseline.
    const walPath = `${sqlitePath}-wal`;
    const payload = Buffer.alloc(256, 0xab);
    fs.writeFileSync(walPath, payload);

    // Establish baseline.
    verify([{ target }]);

    // Overwrite the WAL content WITHOUT changing its size (simulates a same-size WAL
    // commit where SQLite recycles the existing WAL space). (#140467)
    const sameSize = Buffer.alloc(256, 0xcd);
    fs.writeFileSync(walPath, sameSize);

    // Explicitly advance the mtime past the baseline so the test is deterministic across
    // platforms — on some Linux filesystems a same-size rewrite may land within the same
    // nanosecond tick as the baseline. A real same-size WAL commit changes the WAL mtime.
    const walFuture = new Date((Date.now() / 1000) * 1000 + 60_000);
    fs.utimesSync(walPath, walFuture, walFuture);

    // SHOULD throw — the WAL file (index 1) is fully fenced, so the ctime/mtime change
    // from the in-place content rewrite is detected even though size is unchanged.
    expect(() => verify([{ target }])).toThrow(
      "Recovery destination database changed; preview cleanup again.",
    );
  });

  it("establishes baseline and passes on a clean re-check", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    verify([{ target }]);
    // A clean re-check with no changes should not throw.
    expect(() => verify([{ target }])).not.toThrow();
  });
});
