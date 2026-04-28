import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  configureSqliteWalMaintenance,
} from "./sqlite-wal.js";

function createMockDb(): DatabaseSync {
  return {
    exec: vi.fn(),
  } as unknown as DatabaseSync;
}

describe("sqlite WAL maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enables WAL mode and explicit autocheckpointing", () => {
    const db = createMockDb();

    configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });

    expect(db.exec).toHaveBeenNthCalledWith(1, "PRAGMA journal_mode = WAL;");
    expect(db.exec).toHaveBeenNthCalledWith(
      2,
      `PRAGMA wal_autocheckpoint = ${DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
    );
  });

  it("runs periodic TRUNCATE checkpoints and stops them on close", () => {
    vi.useFakeTimers();
    const db = createMockDb();

    const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 100 });
    expect(db.exec).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    expect(db.exec).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
    expect(db.exec).toHaveBeenCalledTimes(3);

    expect(maintenance.close()).toBe(true);
    expect(db.exec).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(200);
    expect(db.exec).toHaveBeenCalledTimes(4);
  });

  it("reports checkpoint errors without throwing from background maintenance", () => {
    const db = createMockDb();
    const error = new Error("busy");
    const onCheckpointError = vi.fn();
    vi.mocked(db.exec).mockImplementation((sql) => {
      if (sql.includes("wal_checkpoint")) {
        throw error;
      }
    });

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      onCheckpointError,
    });

    expect(maintenance.checkpoint()).toBe(false);
    expect(onCheckpointError).toHaveBeenCalledWith(error);
  });
});
