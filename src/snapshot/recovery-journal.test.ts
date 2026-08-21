import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const sqliteOpenState = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((databasePath: string) => Promise<void> | void),
  afterQuery: undefined as undefined | (() => void),
}));

vi.mock("../infra/kysely-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/kysely-sync.js")>();
  return {
    ...actual,
    executeSqliteQuerySync: (...args: Parameters<typeof actual.executeSqliteQuerySync>) => {
      const result = actual.executeSqliteQuerySync(...args);
      sqliteOpenState.afterQuery?.();
      return result;
    },
  };
});

vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (
      ...args: Parameters<typeof actual.openNodeSqliteDatabase>
    ): ReturnType<typeof actual.openNodeSqliteDatabase> => {
      const [databasePath] = args;
      void sqliteOpenState.beforeOpen?.(databasePath);
      return actual.openNodeSqliteDatabase(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  sqliteOpenState.beforeOpen = undefined;
  sqliteOpenState.afterQuery = undefined;
});

describe("recovery journal", () => {
  it("rejects a journal pathname replacement before SQLite writes", async () => {
    const { writeRecoveryJournalRecord } = await import("./recovery-journal.js");
    const root = tempDirs.make("openclaw-recovery-journal-race-");
    const journalPath = path.join(root, "recovery-journal.sqlite");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(journalPath, "", { mode: 0o600 });
    sqliteOpenState.beforeOpen = (databasePath) => {
      fsSync.renameSync(databasePath, `${databasePath}.replaced`);
      fsSync.writeFileSync(databasePath, "", { mode: 0o600 });
    };

    await expect(writeRecoveryJournalRecord(journalPath, "intent", { ok: true })).rejects.toThrow(
      "Recovery journal identity changed before SQLite ownership was established.",
    );
  });

  it("rejects a journal pathname replacement after the record write", async () => {
    const { writeRecoveryJournalRecord } = await import("./recovery-journal.js");
    const root = tempDirs.make("openclaw-recovery-journal-late-race-");
    const journalPath = path.join(root, "recovery-journal.sqlite");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    sqliteOpenState.afterQuery = () => {
      fsSync.renameSync(journalPath, `${journalPath}.replaced`);
      fsSync.writeFileSync(journalPath, "", { mode: 0o600 });
      sqliteOpenState.afterQuery = undefined;
    };

    await expect(writeRecoveryJournalRecord(journalPath, "intent", { ok: true })).rejects.toThrow(
      "Recovery journal identity changed during record commit.",
    );
  });
});
