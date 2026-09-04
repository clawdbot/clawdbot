import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { backupSqliteOnline, isSqliteBackupContentionError } from "./sqlite-online-backup.js";

// A regression that drops the bound must fail fast instead of spinning forever.
const MOCK_BACKUP_STEP_CEILING = 100_000;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });
});

function createDatabasePaths(): { destinationPath: string; sourcePath: string } {
  const tempDir = tempDirs.make("openclaw-sqlite-online-backup-");
  const sourcePath = path.join(tempDir, "source.sqlite");
  const destinationPath = path.join(tempDir, "destination.sqlite");
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath);
  source.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe VALUES ('ready');");
  source.close();
  return { destinationPath, sourcePath };
}

// The bound is elapsed monotonic time, so the time each shape needs is
// simulated. Date is faked next to performance so a test can move wall time
// without moving the deadline; timers stay live because the unmocked cases
// still drive the real node:sqlite backup.
function useSimulatedBackupClock(): (elapsedMs: number) => void {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  return (elapsedMs: number) => {
    vi.advanceTimersByTime(elapsedMs);
  };
}

function readPragmaValue(database: DatabaseSync, pragma: string): unknown {
  return Object.values(database.prepare(`PRAGMA ${pragma};`).get() ?? {})[0];
}

function expectContentionGuidance(error: unknown, sourcePath: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(isSqliteBackupContentionError(error)).toBe(true);
  // The backup boundary recognises this failure through the wrapping every
  // caller adds, never by matching message text.
  expect(isSqliteBackupContentionError(new Error("wrapped", { cause: error }))).toBe(true);
  expect((error as Error).message).toContain(sourcePath);
  expect((error as Error).message).toMatch(
    /could not reach a consistent copy.*(stop the gateway|quiesce writes)/isu,
  );
  // Read-only state-database opens and ownership checks reach this owner too,
  // so it must never name a backup command.
  expect((error as Error).message).not.toMatch(/only-config/iu);
}

describe("backupSqliteOnline", () => {
  it("owns the pinned read transaction through backup and closes it afterward", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    let pinnedSource: DatabaseSync | undefined;

    await backupSqliteOnline({
      ...paths,
      beforeBackup: (source) => {
        pinnedSource = source;
        expect(source.isTransaction).toBe(true);
        expect(readPragmaValue(source, "busy_timeout")).toBe(30_000);
        expect(readPragmaValue(source, "trusted_schema")).toBe(0);
      },
    });

    expect(pinnedSource?.isOpen).toBe(false);
    const destination = new sqlite.DatabaseSync(paths.destinationPath, { readOnly: true });
    expect(destination.prepare("SELECT value FROM probe").get()).toEqual({ value: "ready" });
    destination.close();
  });

  it("rejects a reported jump-up livelock", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const advance = useSimulatedBackupClock();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      // The mock tolerates a missing progress option so pre-fix code, which
      // passed none, reproduces the reported hang instead of failing on the
      // mock's own shape.
      options?.progress?.({ remainingPages: 100, totalPages: 120 });
      for (let cycle = 0; cycle < MOCK_BACKUP_STEP_CEILING; cycle += 1) {
        advance(60_000);
        for (let remainingPages = 101; remainingPages <= 120; remainingPages += 1) {
          options?.progress?.({ remainingPages, totalPages: 120 });
        }
      }
      throw new Error(`backup progress was not bounded in ${MOCK_BACKUP_STEP_CEILING} cycles`);
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });

  it("holds the no-progress deadline when the wall clock is corrected backward", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const advance = useSimulatedBackupClock();
    let cyclesBeforeAbort = 0;
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      options?.progress?.({ remainingPages: 100, totalPages: 120 });
      // One backward correction of ten minutes right after the deadline is
      // armed. A deadline read from Date waits those ten minutes on top of
      // its budget; a monotonic one does not notice.
      vi.setSystemTime(Date.now() - 10 * 60_000);
      for (let cycle = 1; cycle <= MOCK_BACKUP_STEP_CEILING; cycle += 1) {
        cyclesBeforeAbort = cycle;
        advance(60_000);
        for (let remainingPages = 101; remainingPages <= 120; remainingPages += 1) {
          options?.progress?.({ remainingPages, totalPages: 120 });
        }
      }
      throw new Error(`backup progress was not bounded in ${MOCK_BACKUP_STEP_CEILING} cycles`);
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
    // Thirty one-minute cycles exhaust the budget, so the abort lands on the
    // first step of the next cycle whatever wall time says.
    expect(cyclesBeforeAbort).toBe(31);
  });

  it("rejects a flat progress stream", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      for (let step = 0; step < MOCK_BACKUP_STEP_CEILING; step += 1) {
        options?.progress?.({ remainingPages: 50, totalPages: 50 });
      }
      throw new Error(`backup progress was not bounded in ${MOCK_BACKUP_STEP_CEILING} steps`);
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });

  it("rejects when a real node:sqlite progress callback throws", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const source = new sqlite.DatabaseSync(paths.sourcePath);
    try {
      source.exec("PRAGMA page_size = 4096; VACUUM; CREATE TABLE payload (data BLOB NOT NULL);");
      const insert = source.prepare("INSERT INTO payload (data) VALUES (?)");
      for (let index = 0; index < 64; index += 1) {
        insert.run(Buffer.alloc(8192, index));
      }
    } finally {
      source.close();
    }

    const reopened = new sqlite.DatabaseSync(paths.sourcePath, { readOnly: true });
    const progressError = new Error("real progress callback throw");
    let progressCalls = 0;
    try {
      await expect(
        sqlite.backup(reopened, paths.destinationPath, {
          rate: 1,
          progress: () => {
            progressCalls += 1;
            throw progressError;
          },
        }),
      ).rejects.toBe(progressError);
    } finally {
      reopened.close();
    }

    expect(progressCalls).toBe(1);
  });

  it("never aborts a copy that keeps lowering its remaining page count, however slowly", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const advance = useSimulatedBackupClock();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      const totalPages = 50_001;
      for (let remainingPages = totalPages; remainingPages > 0; remainingPages -= 1) {
        // Ten minutes per copied page: slow is not stuck.
        advance(10 * 60_000);
        options?.progress?.({ remainingPages, totalPages });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("allows far more restarts than any restart budget while each pass reaches a new minimum", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const advance = useSimulatedBackupClock();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      const totalPages = 2_000;
      options?.progress?.({ remainingPages: totalPages - 1, totalPages });
      for (let newMinimum = totalPages - 2; newMinimum >= 0; newMinimum -= 1) {
        options?.progress?.({ remainingPages: totalPages, totalPages });
        // Each pass costs 29 simulated minutes and buys one page of headway,
        // which is the shape the reviewer measured at 1,024 restarts.
        advance(29 * 60_000);
        options?.progress?.({ remainingPages: newMinimum, totalPages });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("allows one restart followed by recovery much longer than both contention bounds", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, destination, options) => {
      const totalPages = 50_002;
      options?.progress?.({ remainingPages: 1, totalPages });
      options?.progress?.({ remainingPages: totalPages, totalPages });
      for (let remainingPages = totalPages - 1; remainingPages >= 0; remainingPages -= 1) {
        options?.progress?.({ remainingPages, totalPages });
      }
      return await backup(source, destination);
    });

    await backupSqliteOnline(paths);
    expect(fs.existsSync(paths.destinationPath)).toBe(true);
  });

  it("rejects partial-progress cycles that never beat the best remaining page count", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const advance = useSimulatedBackupClock();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      options?.progress?.({ remainingPages: 100, totalPages: 110 });
      for (let cycle = 0; cycle < MOCK_BACKUP_STEP_CEILING; cycle += 1) {
        advance(5 * 60_000);
        for (const remainingPages of [110, 109, 108]) {
          options?.progress?.({ remainingPages, totalPages: 110 });
        }
      }
      throw new Error(`backup progress was not bounded in ${MOCK_BACKUP_STEP_CEILING} cycles`);
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });

  it("rejects a near-converging copy whose headway costs more than the no-progress budget", async () => {
    const sqlite = requireNodeSqlite();
    const paths = createDatabasePaths();
    const advance = useSimulatedBackupClock();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      const totalPages = 6_000;
      let best = totalPages - 1;
      options?.progress?.({ remainingPages: best, totalPages });
      for (let pass = 0; pass < MOCK_BACKUP_STEP_CEILING; pass += 1) {
        options?.progress?.({ remainingPages: totalPages, totalPages });
        // Real headway, but one page of it per 45 simulated minutes: at this
        // rate the copy outlives any operator, so the budget stops it.
        advance(45 * 60_000);
        best -= 1;
        options?.progress?.({ remainingPages: best, totalPages });
      }
      throw new Error(`backup progress was not bounded in ${MOCK_BACKUP_STEP_CEILING} passes`);
    });

    const error = await backupSqliteOnline(paths).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expectContentionGuidance(error, paths.sourcePath);
  });
});
