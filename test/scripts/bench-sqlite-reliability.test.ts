// SQLite reliability proof tests cover CLI safety and one real snapshot round trip.
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSqliteReliabilityCli } from "../../scripts/lib/sqlite-reliability-cli.js";
import type { ReliabilityReport } from "../../scripts/lib/sqlite-reliability-contract.js";
import { monitorSqliteWalDuring } from "../../scripts/lib/sqlite-reliability-wal-monitor.js";
import {
  canonicalPathWithExistingParent,
  isPendingPathInRepository,
} from "../../scripts/lib/sqlite-reliability-worker-paths.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";

const tempDirs: string[] = [];
// Windows repeats ACL checks and >64 MiB crash/restore copies across two full runs.
const RELIABILITY_PROOF_TIMEOUT_MS = process.platform === "win32" ? 480_000 : 240_000;
const RELIABILITY_SMOKE_TEST_TIMEOUT_MS = process.platform === "win32" ? 1_200_000 : 300_000;

function reliabilitySmokeTest(name: string, test: () => void): void {
  it(name, test, RELIABILITY_SMOKE_TEST_TIMEOUT_MS);
}

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-reliability-test-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function runProof(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-sqlite-reliability.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: RELIABILITY_PROOF_TIMEOUT_MS,
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function waitForChildReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("writer child did not become ready"));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { kind?: unknown }).kind === "ready"
      ) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("writer child exited before ready"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function waitForChildExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("writer child did not exit after IPC disconnect"));
    }, 10_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("scripts/bench-sqlite-reliability", () => {
  it("detects a transient WAL overrun before the file shrinks", async () => {
    const walPath = path.join(makeTempDir(), "database.sqlite-wal");
    let stopRequests = 0;

    await expect(
      monitorSqliteWalDuring({
        maxWalBytes: 1024,
        onLimitExceeded: () => {
          stopRequests += 1;
        },
        operation: async () => {
          fs.writeFileSync(walPath, Buffer.alloc(2048));
          await new Promise((resolve) => setTimeout(resolve, 25));
          fs.truncateSync(walPath, 0);
          return "complete";
        },
        pollIntervalMs: 5,
        walPath,
      }),
    ).rejects.toThrow("SQLite reliability WAL exceeded the 1024-byte profile limit: 2048 bytes");
    expect(stopRequests).toBe(1);
  });

  it("rejects malformed arguments before creating state", () => {
    const unknown = runProof(["--wat"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr.trim()).toBe("error: Unknown argument: --wat");

    expect(() => parseSqliteReliabilityCli(["--profile", "smoke", "--profile", "large"])).toThrow(
      "--profile was provided more than once",
    );
    expect(() => parseSqliteReliabilityCli(["--profile", "huge"])).toThrow(
      '--profile must be one of smoke, default, large; got "huge"',
    );
    expect(parseSqliteReliabilityCli(["--help", "--profile", "huge"])).toEqual({
      help: true,
    });
  });

  reliabilitySmokeTest("reuses a state directory without stale rows or restore collisions", () => {
    const stateDir = makeTempDir();
    const firstOutput = path.join(stateDir, "report-first.json");
    const firstResult = runProof([
      "--profile",
      "smoke",
      "--state-dir",
      stateDir,
      "--output",
      firstOutput,
    ]);

    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(firstResult.stderr).toBe("");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_TARGET=global");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_RESTORES_VERIFIED=7");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_CRASH_RECOVERY=verified");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_PUBLICATION_INTERRUPTION=verified");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_RESTORE_INTERRUPTION=verified");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_REPOSITORY_INTERRUPTION=verified");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_INDEX_REPAIR_INTERRUPTION=verified");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_VACUUM_INTERRUPTION=verified");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_POST_COMPACT_RESTORE=verified");
    const firstReport = JSON.parse(fs.readFileSync(firstOutput, "utf8")) as ReliabilityReport;
    expect(firstReport.concurrentRestoresVerified).toBe(4);
    expect(firstReport.restoresVerified).toBe(7);
    expect(firstReport.crashRecoveryProof.sourceRecovered).toBe(true);
    expect(firstReport.crashRecoveryProof.committedStatePreserved).toBe(true);
    expect(firstReport.crashRecoveryProof.partialVisibleAfterRecovery).toBe(false);
    expect(firstReport.crashRecoveryProof.writerRestarted).toBe(true);
    expect(
      firstReport.crashRecoveryProof.exit.code !== null ||
        firstReport.crashRecoveryProof.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.crashRecoveryProof.stateAfterRecovery).toEqual(
      firstReport.crashRecoveryProof.stateBeforeKill,
    );
    expect(firstReport.publicationInterruptionProof.beforePublish).toMatchObject({
      recoveryVerified: true,
      retryPublished: true,
      sourceStatePreserved: true,
      targetVerifiedAfterCrash: false,
      targetVisibleAfterCrash: false,
    });
    expect(firstReport.publicationInterruptionProof.beforePublish.stagingEntries).toBeGreaterThan(
      0,
    );
    expect(
      firstReport.publicationInterruptionProof.beforePublish.exit.code !== null ||
        firstReport.publicationInterruptionProof.beforePublish.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.publicationInterruptionProof.afterPublish).toMatchObject({
      existingTargetPreserved: true,
      recoveryVerified: true,
      sourceStatePreserved: true,
      targetVerifiedAfterCrash: true,
      targetVisibleAfterCrash: true,
    });
    expect(firstReport.publicationInterruptionProof.afterPublish.stagingEntries).toBeGreaterThan(0);
    expect(
      firstReport.publicationInterruptionProof.afterPublish.exit.code !== null ||
        firstReport.publicationInterruptionProof.afterPublish.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.indexRepairInterruptionProof.rollbackJournal).toMatchObject({
      recoveryVerified: true,
      repairedIndexes: ["idx_openclaw_reliability_records_identity"],
      rowsPreserved: 32_768,
    });
    expect(
      firstReport.indexRepairInterruptionProof.rollbackJournal.journalBytesObserved,
    ).toBeGreaterThan(0);
    expect(
      firstReport.indexRepairInterruptionProof.rollbackJournal.exit.code !== null ||
        firstReport.indexRepairInterruptionProof.rollbackJournal.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.indexRepairInterruptionProof.wal).toMatchObject({
      recoveryVerified: true,
      repairedIndexes: ["idx_openclaw_reliability_records_identity"],
      rowsPreserved: 32_768,
    });
    expect(firstReport.indexRepairInterruptionProof.wal.walBytesObserved).toBeGreaterThan(0);
    expect(
      firstReport.indexRepairInterruptionProof.wal.exit.code !== null ||
        firstReport.indexRepairInterruptionProof.wal.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.transactionProof.committedWalSentinel).toBe(true);
    expect(firstReport.transactionProof.heldRows).toBeGreaterThan(0);
    expect(firstReport.transactionProof.visibleAfterRestore).toBe(false);
    expect(firstReport.writer.rowsCommitted).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.bloatBytes).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.compaction.autoVacuum.after).toBe(2);
    expect(firstReport.maintenanceProof.compaction.freelistPages.before).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.compaction.freelistPages.after).toBe(0);
    expect(firstReport.maintenanceProof.compaction.reclaimedBytes).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.compaction.walBytes.after).toBe(0);
    expect(firstReport.maintenanceProof.vacuumInterruption.recoveryVerified).toBe(true);
    expect(firstReport.maintenanceProof.vacuumInterruption.autoVacuumBeforeKill).toBe(0);
    expect(firstReport.maintenanceProof.vacuumInterruption.autoVacuumAfterRecovery).toBe(0);
    expect(
      firstReport.maintenanceProof.vacuumInterruption.exit.code !== null ||
        firstReport.maintenanceProof.vacuumInterruption.exit.signal !== null,
    ).toBe(true);
    expect(
      firstReport.maintenanceProof.vacuumInterruption.journalBytesObserved > 0 ||
        firstReport.maintenanceProof.vacuumInterruption.walBytesObserved > 0,
    ).toBe(true);
    expect(firstReport.maintenanceProof.vacuumInterruption.payloadAfterRecovery).toEqual(
      firstReport.maintenanceProof.vacuumInterruption.payloadBeforeKill,
    );
    expect(firstReport.maintenanceProof.vacuumInterruption.stateAfterRecovery).toEqual(
      firstReport.maintenanceProof.vacuumInterruption.stateBeforeKill,
    );
    expect(firstReport.maintenanceProof.repositoryInterruption.beforePending).toMatchObject({
      crashSnapshotVerifiedAfterCrash: false,
      crashSnapshotVisibleAfterCrash: false,
      incompleteEntries: 1,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
      visibleSnapshotsAfterCrash: 1,
    });
    expect(
      firstReport.maintenanceProof.repositoryInterruption.beforePending.stagingEntries,
    ).toBeGreaterThan(0);
    expect(
      firstReport.maintenanceProof.repositoryInterruption.beforePending.exit.code !== null ||
        firstReport.maintenanceProof.repositoryInterruption.beforePending.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.maintenanceProof.repositoryInterruption.pending).toMatchObject({
      crashSnapshotVerifiedAfterCrash: true,
      crashSnapshotVisibleAfterCrash: true,
      incompleteEntries: 0,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
      visibleSnapshotsAfterCrash: 3,
    });
    expect(
      firstReport.maintenanceProof.repositoryInterruption.pending.stagingEntries,
    ).toBeGreaterThan(0);
    expect(
      firstReport.maintenanceProof.repositoryInterruption.pending.exit.code !== null ||
        firstReport.maintenanceProof.repositoryInterruption.pending.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.maintenanceProof.repositoryInterruption.afterCommit).toMatchObject({
      crashSnapshotVerifiedAfterCrash: true,
      crashSnapshotVisibleAfterCrash: true,
      incompleteEntries: 0,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
      visibleSnapshotsAfterCrash: 5,
    });
    expect(
      firstReport.maintenanceProof.repositoryInterruption.afterCommit.stagingEntries,
    ).toBeGreaterThan(0);
    expect(
      firstReport.maintenanceProof.repositoryInterruption.afterCommit.exit.code !== null ||
        firstReport.maintenanceProof.repositoryInterruption.afterCommit.exit.signal !== null,
    ).toBe(true);
    expect(firstReport.maintenanceProof.repositoryInterruption.beforePending.state).toEqual(
      firstReport.maintenanceProof.repositoryInterruption.pending.state,
    );
    expect(firstReport.maintenanceProof.repositoryInterruption.pending.state).toEqual(
      firstReport.maintenanceProof.repositoryInterruption.afterCommit.state,
    );
    expect(firstReport.maintenanceProof.repositoryInterruption.beforePending.payload).toEqual(
      firstReport.maintenanceProof.repositoryInterruption.pending.payload,
    );
    expect(firstReport.maintenanceProof.repositoryInterruption.pending.payload).toEqual(
      firstReport.maintenanceProof.repositoryInterruption.afterCommit.payload,
    );
    expect(firstReport.maintenanceProof.restoreInterruption.snapshotBytes).toBeGreaterThan(
      64 * 1024 * 1024,
    );
    expect(firstReport.maintenanceProof.restoreInterruption.beforePublish).toMatchObject({
      existingTargetPreserved: false,
      recoveryVerified: true,
      repositoryVerified: true,
      retryRestored: true,
      targetVerifiedAfterCrash: false,
      targetVisibleAfterCrash: false,
    });
    expect(
      firstReport.maintenanceProof.restoreInterruption.beforePublish.stagingEntries,
    ).toBeGreaterThan(0);
    expect(
      firstReport.maintenanceProof.restoreInterruption.beforePublish.exit.code !== null ||
        firstReport.maintenanceProof.restoreInterruption.beforePublish.exit.signal !== null,
    ).toBe(true);
    expect(
      firstReport.maintenanceProof.restoreInterruption.beforePublish.stateAfterRecovery,
    ).toEqual(firstReport.maintenanceProof.postCompact.state);
    expect(
      firstReport.maintenanceProof.restoreInterruption.beforePublish.payloadAfterRecovery,
    ).toEqual(firstReport.maintenanceProof.vacuumInterruption.payloadBeforeKill);
    expect(firstReport.maintenanceProof.restoreInterruption.afterPublish).toMatchObject({
      existingTargetPreserved: true,
      recoveryVerified: true,
      repositoryVerified: true,
      retryRestored: false,
      targetVerifiedAfterCrash: true,
      targetVisibleAfterCrash: true,
    });
    expect(
      firstReport.maintenanceProof.restoreInterruption.afterPublish.stagingEntries,
    ).toBeGreaterThan(0);
    expect(
      firstReport.maintenanceProof.restoreInterruption.afterPublish.exit.code !== null ||
        firstReport.maintenanceProof.restoreInterruption.afterPublish.exit.signal !== null,
    ).toBe(true);
    expect(
      firstReport.maintenanceProof.restoreInterruption.afterPublish.stateAfterRecovery,
    ).toEqual(firstReport.maintenanceProof.restoreInterruption.beforePublish.stateAfterRecovery);
    expect(
      firstReport.maintenanceProof.restoreInterruption.afterPublish.payloadAfterRecovery,
    ).toEqual(firstReport.maintenanceProof.restoreInterruption.beforePublish.payloadAfterRecovery);
    expect(firstReport.maintenanceProof.postCompact.restoreVerified).toBe(true);
    expect(firstReport.maintenanceProof.postCompact.state.batches).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.postCompact.state.rows).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.postCompact.state.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstReport.walBytes.limit).toBeGreaterThan(0);
    expect(firstReport.walBytes.peak).toBeGreaterThan(0);
    expect(firstReport.walBytes.peak).toBeLessThanOrEqual(firstReport.walBytes.limit);

    const database = openNodeSqliteDatabase(firstReport.paths.sourceDatabase);
    try {
      database
        .prepare(
          "INSERT INTO openclaw_reliability_entries (batch, ordinal, payload) VALUES (?, ?, ?)",
        )
        .run(999_999, 0, "stale-profile-row");
    } finally {
      database.close();
    }

    const secondOutput = path.join(stateDir, "report-second.json");
    const secondResult = runProof([
      "--profile",
      "smoke",
      "--state-dir",
      stateDir,
      "--output",
      secondOutput,
    ]);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    const secondReport = JSON.parse(fs.readFileSync(secondOutput, "utf8")) as {
      paths: { syncedRepository: string };
      restoresVerified: number;
    };
    expect(secondReport.restoresVerified).toBe(7);
    expect(secondReport.paths.syncedRepository).not.toBe(firstReport.paths.syncedRepository);
  });

  it("matches crash barriers across filesystem path aliases", () => {
    const realRoot = makeTempDir();
    const aliasRoot = path.join(makeTempDir(), "alias");
    fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const repositoryPath = path.join(realRoot, "snapshots");
    const snapshotPath = path.join(repositoryPath, "snapshot");
    fs.mkdirSync(snapshotPath, { recursive: true });

    const canonicalRepositoryPath = canonicalPathWithExistingParent(
      path.join(aliasRoot, "snapshots"),
    );
    expect(canonicalRepositoryPath).toBe(path.join(fs.realpathSync.native(realRoot), "snapshots"));
    expect(
      isPendingPathInRepository(
        path.join(aliasRoot, "snapshots", "snapshot", ".pending"),
        canonicalRepositoryPath,
      ),
    ).toBe(true);

    const finalAlias = path.join(realRoot, "final-alias");
    fs.symlinkSync(snapshotPath, finalAlias, process.platform === "win32" ? "junction" : "dir");
    expect(canonicalPathWithExistingParent(finalAlias)).toBe(
      path.join(fs.realpathSync.native(realRoot), "final-alias"),
    );
  });

  it("stops the writer when its parent IPC channel disconnects", async () => {
    const databasePath = path.join(makeTempDir(), "writer.sqlite");
    const child = fork(
      path.resolve("scripts/lib/sqlite-reliability-writer.ts"),
      [databasePath, "8", "64", "4", "256", String(64 * 1024 * 1024), "1"],
      {
        cwd: process.cwd(),
        execArgv: ["--import", "tsx"],
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    try {
      await waitForChildReady(child);
      const exitPromise = waitForChildExit(child);
      child.disconnect();
      await expect(exitPromise).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  });
});
