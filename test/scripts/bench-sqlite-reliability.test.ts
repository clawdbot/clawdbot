// SQLite reliability proof tests cover CLI safety and one real snapshot round trip.
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseSqliteReliabilityCli } from "../../scripts/lib/sqlite-reliability-cli.js";
import { monitorSqliteWalDuring } from "../../scripts/lib/sqlite-reliability-wal-monitor.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-reliability-test-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function runProof(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-sqlite-reliability.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
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

  it("reuses a state directory without stale rows or restore collisions", () => {
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
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_RESTORES_VERIFIED=5");
    expect(firstResult.stdout).toContain("SQLITE_RELIABILITY_POST_COMPACT_RESTORE=verified");
    const firstReport = JSON.parse(fs.readFileSync(firstOutput, "utf8")) as {
      concurrentRestoresVerified: number;
      maintenanceProof: {
        bloatBytes: number;
        compaction: {
          autoVacuum: { after: number };
          freelistPages: { after: number; before: number };
          reclaimedBytes: number;
          walBytes: { after: number };
        };
        postCompact: {
          restoreVerified: boolean;
          state: {
            batches: number;
            rows: number;
            sha256: string;
          };
        };
      };
      paths: {
        sourceDatabase: string;
        syncedRepository: string;
      };
      restoresVerified: number;
      transactionProof: {
        committedWalSentinel: boolean;
        heldRows: number;
        visibleAfterRestore: boolean;
      };
      walBytes: {
        limit: number;
        peak: number;
      };
      writer: {
        rowsCommitted: number;
      };
    };
    expect(firstReport.concurrentRestoresVerified).toBe(4);
    expect(firstReport.restoresVerified).toBe(5);
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
    expect(firstReport.maintenanceProof.postCompact.restoreVerified).toBe(true);
    expect(firstReport.maintenanceProof.postCompact.state.batches).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.postCompact.state.rows).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.postCompact.state.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstReport.walBytes.limit).toBeGreaterThan(0);
    expect(firstReport.walBytes.peak).toBeGreaterThan(0);
    expect(firstReport.walBytes.peak).toBeLessThanOrEqual(firstReport.walBytes.limit);

    const database = new DatabaseSync(firstReport.paths.sourceDatabase);
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
    expect(secondReport.restoresVerified).toBe(5);
    expect(secondReport.paths.syncedRepository).not.toBe(firstReport.paths.syncedRepository);
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
