import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithSqliteBusyTimeout, shouldReportSqliteLockFailure } from "./sqlite-busy-timeout.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("runWithSqliteBusyTimeout", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("restores the previous timeout after success and failure", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA busy_timeout = 5000");

    expect(
      runWithSqliteBusyTimeout(database, 0, () => database?.prepare("PRAGMA busy_timeout").get()),
    ).toEqual({ timeout: 0 });
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });

    expect(() =>
      runWithSqliteBusyTimeout(database!, 25, () => {
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  it("restores timeout and lock reporting before the admitted operation finishes", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA busy_timeout = 5000");
    runWithSqliteBusyTimeout(
      database,
      25,
      (restore) => {
        expect(shouldReportSqliteLockFailure(database!)).toBe(false);
        restore();
        expect(database!.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        expect(shouldReportSqliteLockFailure(database!)).toBe(true);
      },
      { lockFailureReporting: "suppress" },
    );
    expect(shouldReportSqliteLockFailure(database)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid timeout %s",
    (timeout) => {
      database = new DatabaseSync(":memory:");
      expect(() => runWithSqliteBusyTimeout(database!, timeout, () => undefined)).toThrow(
        "busyTimeoutMs must be a non-negative integer",
      );
    },
  );

  it("suppresses expected lock warnings only for the scoped attempt", () => {
    const databasePath = path.join(tempDirs.make("sqlite-busy-timeout-"), "state.sqlite");
    database = new DatabaseSync(databasePath);
    const contender = new DatabaseSync(databasePath);
    const logger = { warn: vi.fn() };
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY)");
    contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");

    try {
      expect(() =>
        runWithSqliteBusyTimeout(
          database!,
          0,
          () =>
            runSqliteImmediateTransactionSync(database!, () => undefined, {
              busyTimeoutMs: 0,
              logger,
            }),
          { lockFailureReporting: "suppress" },
        ),
      ).toThrow();
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      contender.exec("ROLLBACK");
      contender.close();
    }
  });
});
