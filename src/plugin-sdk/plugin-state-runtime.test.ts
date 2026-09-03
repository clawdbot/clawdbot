import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  configureSqliteConnectionPragmas,
  createPluginStateErrorReporter,
} from "./plugin-state-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createPluginStateErrorReporter", () => {
  it("logs state failures with plugin bindings and default details", () => {
    const warn = vi.fn();
    const getChildLogger = vi.fn(() => ({ warn }));
    const report = createPluginStateErrorReporter(
      () => ({ logging: { getChildLogger } }) as never,
      "test-plugin",
      "state-cache",
      "persistent state failed",
    );

    report(new Error("boom"));

    expect(getChildLogger).toHaveBeenCalledWith({
      plugin: "test-plugin",
      feature: "state-cache",
    });
    expect(warn).toHaveBeenCalledWith("persistent state failed", { error: "Error: boom" });
  });

  it("swallows failures from runtime lookup and error formatting", () => {
    const runtimeFailure = createPluginStateErrorReporter(
      () => {
        throw new Error("runtime unavailable");
      },
      "test-plugin",
      "state-cache",
      "persistent state failed",
    );
    const formattingFailure = createPluginStateErrorReporter(
      () => ({ logging: { getChildLogger: () => ({ warn: vi.fn() }) } }) as never,
      "test-plugin",
      "state-cache",
      "persistent state failed",
      () => {
        throw new Error("formatting failed");
      },
    );

    expect(() => runtimeFailure(new Error("boom"))).not.toThrow();
    expect(() => formattingFailure(new Error("boom"))).not.toThrow();
  });
});

describe("published plugin state SQLite runtime", () => {
  it("keeps the WAL retry budget stable across wall-clock jumps", () => {
    vi.useFakeTimers();
    const databasePath = path.join(tempDirs.make("openclaw-plugin-state-wal-"), "state.sqlite");
    const database = new DatabaseSync(databasePath);
    let journalModeAttempts = 0;
    const instrumentedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            if (sql === "PRAGMA journal_mode = WAL;" && journalModeAttempts++ === 0) {
              vi.setSystemTime(Date.now() + 1_000_000);
              throw Object.assign(new Error("database is locked"), {
                code: "ERR_SQLITE_ERROR",
                errcode: 5,
              });
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    try {
      const maintenance = configureSqliteConnectionPragmas(instrumentedDatabase, {
        busyTimeoutMs: 50,
        checkpointIntervalMs: 0,
        databasePath,
      });

      expect(journalModeAttempts).toBe(2);
      expect(database.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
      expect(maintenance.close()).toBe(true);
    } finally {
      database.close();
    }
  });
});
