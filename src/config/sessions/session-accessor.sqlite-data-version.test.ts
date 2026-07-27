import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { configureSqliteConnectionPragmas } from "../../infra/sqlite-wal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  listSessionEntries,
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
  openSessionEntryReadView,
  upsertSessionEntry,
} from "./session-accessor.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

const parseSessionEntryCalls = vi.hoisted(() => vi.fn());

vi.mock("./session-accessor.sqlite-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSqliteSessionEntryJson: (
      row: Parameters<typeof actual.parseSqliteSessionEntryJson>[0],
    ) => {
      parseSessionEntryCalls();
      return actual.parseSqliteSessionEntryJson(row);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  parseSessionEntryCalls.mockClear();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}

describe("SQLite data_version", () => {
  it("changes for another WAL connection's commit but not the connection's own commit", () => {
    const databasePath = path.join(tempDirs.make("openclaw-data-version-"), "probe.sqlite");
    const first = new DatabaseSync(databasePath);
    const firstMaintenance = configureSqliteConnectionPragmas(first, {
      checkpointIntervalMs: 0,
      databaseLabel: "data-version-first",
      databasePath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    first.exec("CREATE TABLE probe (value TEXT NOT NULL) STRICT;");
    const second = new DatabaseSync(databasePath);
    const secondMaintenance = configureSqliteConnectionPragmas(second, {
      checkpointIntervalMs: 0,
      databaseLabel: "data-version-second",
      databasePath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });

    try {
      expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(second.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });

      const firstVersion = readDataVersion(first);
      first.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES ('first'); COMMIT;");
      expect(readDataVersion(first)).toBe(firstVersion);

      const secondVersion = readDataVersion(second);
      second.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES ('second'); COMMIT;");
      expect(readDataVersion(second)).toBe(secondVersion);
      expect(readDataVersion(first)).not.toBe(firstVersion);
    } finally {
      secondMaintenance.close();
      second.close();
      firstMaintenance.close();
      first.close();
    }
  });
});

function createSessionScope(label: string) {
  const stateDir = tempDirs.make(`openclaw-entry-cache-${label}-`);
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionKey: `agent:main:${label}`,
  };
}

describe("SQLite session entry cache", () => {
  it("reuses parsed entries on the second list", async () => {
    const scope = createSessionScope("second-list");
    await upsertSessionEntry(scope, { label: "first", sessionId: "first", updatedAt: 1 });
    await upsertSessionEntry(
      { ...scope, sessionKey: "agent:main:second-list-2" },
      { label: "second", sessionId: "second", updatedAt: 2 },
    );

    parseSessionEntryCalls.mockClear();
    const first = listSessionEntries(scope);
    const firstParseCount = parseSessionEntryCalls.mock.calls.length;
    const second = listSessionEntries(scope);

    expect(firstParseCount).toBe(2);
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(firstParseCount);
    expect(second).toEqual(first);
  });

  it("reloads after another connection commits", async () => {
    const scope = createSessionScope("external-write");
    await upsertSessionEntry(scope, { label: "before", sessionId: "external", updatedAt: 1 });
    const before = listSessionEntries(scope)[0]?.entry;
    expect(before).toBeDefined();
    if (!before) {
      throw new Error("missing seeded external-write entry");
    }
    const database = openOpenClawAgentDatabase(scope);
    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "session-entry-external-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      const updated = { ...before, label: "after", updatedAt: 2 };
      external
        .prepare(
          "UPDATE session_nodes SET entry_json = ?, label = ?, updated_at = ? WHERE session_key = ?",
        )
        .run(JSON.stringify(updated), updated.label, updated.updatedAt, scope.sessionKey);

      parseSessionEntryCalls.mockClear();
      expect(listSessionEntries(scope)[0]?.entry.label).toBe("after");
      expect(parseSessionEntryCalls).toHaveBeenCalledTimes(1);
    } finally {
      maintenance.close();
      external.close();
    }
  });

  it("writes through a same-process upsert without reloading the store", async () => {
    const scope = createSessionScope("write-through");
    await upsertSessionEntry(scope, { label: "before", sessionId: "write-through", updatedAt: 1 });
    listSessionEntries(scope);

    await upsertSessionEntry(scope, { label: "after", updatedAt: 2 });
    parseSessionEntryCalls.mockClear();

    expect(listSessionEntries(scope)[0]?.entry.label).toBe("after");
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });

  it("invalidates cached keys when transcript creation inserts a placeholder node", async () => {
    const scope = createSessionScope("placeholder-key");
    await upsertSessionEntry(scope, { sessionId: "entry", updatedAt: 1 });
    expect(listSessionEntryKeysReadOnly({ agentId: scope.agentId, env: scope.env })).toEqual([
      scope.sessionKey,
    ]);

    const placeholderKey = "agent:main:placeholder-only";
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(
        database,
        {
          agentId: scope.agentId,
          env: scope.env,
          sessionId: "placeholder-only",
          sessionKey: placeholderKey,
        },
        2,
      );
    }, scope);

    expect(listSessionEntryKeysReadOnly({ agentId: scope.agentId, env: scope.env })).toEqual([
      scope.sessionKey,
      placeholderKey,
    ]);
  });

  it("bypasses the cache in a transaction without publishing rolled-back state", async () => {
    const scope = createSessionScope("transaction-rollback");
    await upsertSessionEntry(scope, { label: "before", sessionId: "rollback", updatedAt: 1 });
    const borrowedBefore = openSessionEntryReadView(scope).get(scope.sessionKey);
    expect(borrowedBefore?.label).toBe("before");
    if (!borrowedBefore) {
      throw new Error("missing seeded rollback entry");
    }

    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        const updated = { ...borrowedBefore, label: "uncommitted", updatedAt: 2 };
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
          .run(JSON.stringify(updated), updated.updatedAt, scope.sessionKey);
        expect(loadSessionEntry({ ...scope, clone: false })?.label).toBe("uncommitted");
        throw new Error("roll back cache probe");
      }, scope),
    ).toThrow("roll back cache probe");

    parseSessionEntryCalls.mockClear();
    const borrowedAfter = openSessionEntryReadView(scope).get(scope.sessionKey);
    expect(borrowedAfter).toBe(borrowedBefore);
    expect(borrowedAfter?.label).toBe("before");
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });

  it("isolates cloned results while borrowed views retain stable references", async () => {
    const scope = createSessionScope("clone-borrow");
    await upsertSessionEntry(scope, { label: "original", sessionId: "clone", updatedAt: 1 });

    const cloned = listSessionEntries(scope)[0]?.entry;
    expect(cloned).toBeDefined();
    if (cloned) {
      cloned.label = "mutated";
    }
    expect(loadSessionEntry(scope)?.label).toBe("original");

    const view = openSessionEntryReadView(scope);
    const first = view.get(scope.sessionKey);
    expect(view.get(scope.sessionKey)).toBe(first);
    expect(view.entries()[0]?.entry).toBe(first);
  });

  it("honors latest reads even after an untracked own-connection write", async () => {
    const scope = createSessionScope("latest");
    await upsertSessionEntry(scope, { label: "cached", sessionId: "latest", updatedAt: 1 });
    expect(loadSessionEntry(scope)?.label).toBe("cached");

    const database = openOpenClawAgentDatabase(scope);
    const updated = { label: "latest", sessionId: "latest", updatedAt: 2 };
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(updated), updated.updatedAt, scope.sessionKey);

    expect(loadSessionEntry(scope)?.label).toBe("cached");
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })?.label).toBe("latest");
  });
});
