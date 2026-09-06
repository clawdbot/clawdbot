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

    // Simulate a read-only query touching WAL/SHM state by advancing their
    // mtime/ctime well past the baseline.
    const sidecarPaths = resolveSqliteDatabaseFilePaths(sqlitePath).slice(1);
    const future = new Date((Date.now() / 1000) * 1000 + 60_000);
    for (const sidecar of sidecarPaths) {
      if (fs.existsSync(sidecar)) {
        fs.utimesSync(sidecar, future, future);
      }
    }

    // Should NOT throw — sidecar dev/ino are unchanged, only ctime/mtime churned.
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

    // Establish baseline.
    verify([{ target }]);

    // Delete a sidecar file that existed in the baseline. The verifier should
    // detect the identity change (dev/ino now undefined vs. recorded BigInt).
    const walPath = `${sqlitePath}-wal`;
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
      // SHOULD throw — sidecar identity (dev/ino) changed from recorded to undefined.
      expect(() => verify([{ target }])).toThrow(
        "Recovery destination database changed; preview cleanup again.",
      );
    } else {
      // If no WAL sidecar exists, create one and verify deletion is detected.
      fs.writeFileSync(walPath, Buffer.alloc(32));
      verify([{ target }]); // Re-establish baseline with the WAL present.
      fs.unlinkSync(walPath);
      expect(() => verify([{ target }])).toThrow(
        "Recovery destination database changed; preview cleanup again.",
      );
    }
  });

  it("establishes baseline and passes on a clean re-check", () => {
    const verify = createRecoveryDestinationVerifier(stateDir);
    const target = makeMinimalTargetManifest(sqlitePath, agentId);

    verify([{ target }]);
    // A clean re-check with no changes should not throw.
    expect(() => verify([{ target }])).not.toThrow();
  });
});
