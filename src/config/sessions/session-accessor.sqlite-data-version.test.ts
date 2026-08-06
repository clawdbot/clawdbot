import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
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
import { readSqliteSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

const parseSessionEntryCalls = vi.hoisted(() => vi.fn());
const listProjectionCalls = vi.hoisted(() => vi.fn());

vi.mock("./session-accessor.sqlite-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSqliteSessionEntryJson: (
      row: Parameters<typeof actual.parseSqliteSessionEntryJson>[0],
    ) => {
      parseSessionEntryCalls();
      const entry = actual.parseSqliteSessionEntryJson(row);
      if (entry?.label?.startsWith("projection-probe")) {
        Object.defineProperty(entry, "__projectionProbe", {
          configurable: true,
          enumerable: true,
          get: () => {
            listProjectionCalls();
            return entry.sessionId;
          },
        });
      }
      return entry;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  parseSessionEntryCalls.mockClear();
  listProjectionCalls.mockClear();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}

function readTotalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS value").get() as { value: number };
  return row.value;
}

describe("SQLite entry cache validity counters", () => {
  it("separately tracks same-connection and other-connection commits", () => {
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
      const firstChanges = readTotalChanges(first);
      first.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES ('first'); COMMIT;");
      expect(readDataVersion(first)).toBe(firstVersion);
      expect(readTotalChanges(first)).toBe(firstChanges + 1);

      const secondVersion = readDataVersion(second);
      const secondChanges = readTotalChanges(second);
      second.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES ('second'); COMMIT;");
      expect(readDataVersion(second)).toBe(secondVersion);
      expect(readTotalChanges(second)).toBe(secondChanges + 1);
      expect(readDataVersion(first)).not.toBe(firstVersion);
      expect(readTotalChanges(first)).toBe(firstChanges + 1);
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
  it("keeps sqlite-entry-cache list projections shallow, lazy, and memoized per key", async () => {
    const scope = createSessionScope("lazy-list-projection");
    await upsertSessionEntry(scope, {
      label: "projected",
      sessionId: "lazy-list-projection",
      updatedAt: 1,
      worktree: { id: "worktree-1", branch: "main", repoRoot: "/repo" },
      skillsSnapshot: { prompt: "large skill prompt", skills: [] },
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    });

    const fullEntry = listSessionEntries({ ...scope, clone: false })[0]?.entry;
    expect(fullEntry).toBeDefined();
    if (!fullEntry) {
      throw new Error("missing seeded lazy-list-projection entry");
    }
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      const first = listSessionEntries({
        ...scope,
        clone: false,
        projection: "list",
      })[0]?.entry;
      const second = listSessionEntries({
        ...scope,
        clone: false,
        projection: "list",
      })[0]?.entry;

      expect(first).not.toBe(fullEntry);
      expect(first?.worktree).toBe(fullEntry.worktree);
      expect(first?.skillsSnapshot).toBeUndefined();
      expect(first?.systemPromptReport).toBeUndefined();
      expect(second).toBe(first);
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

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

  it("keeps same-path caches isolated by live connection", async () => {
    const scope = createSessionScope("connection-identity");
    await upsertSessionEntry(scope, {
      label: "connection-identity",
      sessionId: "connection-identity",
      updatedAt: 1,
    });
    const primary = openOpenClawAgentDatabase(scope);
    const first = listSessionEntries({ ...scope, clone: false });
    const alternate = new DatabaseSync(primary.path, { readOnly: true });

    try {
      parseSessionEntryCalls.mockClear();
      const alternateSnapshot = readSqliteSessionEntryCache(
        { agentId: primary.agentId, db: alternate },
        { cache: true },
      );
      expect(alternateSnapshot.entries.get(scope.sessionKey)?.label).toBe("connection-identity");
      const alternateEntry = alternateSnapshot.entries.get(scope.sessionKey);
      expect(parseSessionEntryCalls).toHaveBeenCalledOnce();

      parseSessionEntryCalls.mockClear();
      const second = listSessionEntries({ ...scope, clone: false });

      expect(second[0]?.entry).toBe(first[0]?.entry);
      expect(parseSessionEntryCalls).not.toHaveBeenCalled();

      parseSessionEntryCalls.mockClear();
      const alternateAgain = readSqliteSessionEntryCache(
        { agentId: primary.agentId, db: alternate },
        { cache: true },
      );

      expect(alternateAgain.entries.get(scope.sessionKey)).toBe(alternateEntry);
      expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(alternate);
      alternate.close();
    }
  });

  it("reuses parsed entries and list projections after a same-connection non-entry write", async () => {
    const scope = createSessionScope("same-connection-non-entry");
    const siblingScope = { ...scope, sessionKey: "agent:main:same-connection-non-entry-2" };
    await upsertSessionEntry(scope, {
      label: "projection-probe-first",
      sessionId: "same-connection-non-entry",
      updatedAt: 1,
    });
    await upsertSessionEntry(siblingScope, {
      label: "projection-probe-second",
      sessionId: "same-connection-non-entry-2",
      updatedAt: 1,
    });
    const first = listSessionEntries({ ...scope, clone: false, projection: "list" });

    const database = openOpenClawAgentDatabase(scope);
    ensureTranscriptSessionRoot(
      database,
      {
        agentId: scope.agentId,
        env: scope.env,
        sessionId: "same-connection-non-entry",
        sessionKey: scope.sessionKey,
      },
      2,
    );
    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();

    const second = listSessionEntries({ ...scope, clone: false, projection: "list" });

    expect(second.map((row) => row.entry)).toEqual(first.map((row) => row.entry));
    expect(second[0]?.entry).toBe(first[0]?.entry);
    expect(second[1]?.entry).toBe(first[1]?.entry);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    expect(listProjectionCalls).not.toHaveBeenCalled();
  });

  it("fully reloads after another connection commits", async () => {
    const scope = createSessionScope("external-write");
    const siblingScope = { ...scope, sessionKey: "agent:main:external-write-sibling" };
    await upsertSessionEntry(scope, {
      label: "projection-probe-before",
      sessionId: "external",
      updatedAt: 1,
    });
    await upsertSessionEntry(siblingScope, {
      label: "projection-probe-sibling",
      sessionId: "external-sibling",
      updatedAt: 1,
    });
    const before = listSessionEntries({ ...scope, clone: false, projection: "list" })[0]?.entry;
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
      const updated = { ...before, label: "projection-probe-after", updatedAt: 2 };
      external
        .prepare(
          "UPDATE session_nodes SET entry_json = ?, label = ?, updated_at = ? WHERE session_key = ?",
        )
        .run(JSON.stringify(updated), updated.label, updated.updatedAt, scope.sessionKey);

      parseSessionEntryCalls.mockClear();
      listProjectionCalls.mockClear();
      expect(
        listSessionEntries({ ...scope, clone: false, projection: "list" })[0]?.entry.label,
      ).toBe("projection-probe-after");
      expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
      expect(listProjectionCalls).toHaveBeenCalledTimes(2);
    } finally {
      maintenance.close();
      external.close();
    }
  });

  it("fully reloads a cross-connection same-millisecond entry rewrite", async () => {
    const scope = createSessionScope("external-same-ms");
    const siblingScope = { ...scope, sessionKey: "agent:main:external-same-ms-sibling" };
    await upsertSessionEntry(scope, {
      label: "projection-probe-before",
      sessionId: "external-same-ms",
      updatedAt: 1_000,
    });
    await upsertSessionEntry(siblingScope, {
      label: "projection-probe-sibling",
      sessionId: "external-same-ms-sibling",
      updatedAt: 1_000,
    });
    const before = listSessionEntries({ ...scope, clone: false, projection: "list" })[0]?.entry;
    if (!before) {
      throw new Error("missing seeded external-same-ms entry");
    }

    const database = openOpenClawAgentDatabase(scope);
    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "session-entry-external-same-ms-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      const updated = { ...before, label: "projection-probe-after" };
      external
        .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
        .run(JSON.stringify(updated), updated.label, scope.sessionKey);

      parseSessionEntryCalls.mockClear();
      listProjectionCalls.mockClear();
      const after = listSessionEntries({ ...scope, clone: false, projection: "list" });

      expect(after[0]?.entry.label).toBe("projection-probe-after");
      expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
      expect(listProjectionCalls).toHaveBeenCalledTimes(2);
    } finally {
      maintenance.close();
      external.close();
    }
  });

  it("incrementally handles added and removed keys on the cached connection", async () => {
    const scope = createSessionScope("same-connection-keys");
    const removedScope = { ...scope, sessionKey: "agent:main:same-connection-removed" };
    await upsertSessionEntry(scope, {
      label: "projection-probe-kept",
      sessionId: "same-connection-kept",
      updatedAt: 1,
    });
    await upsertSessionEntry(removedScope, {
      label: "projection-probe-removed",
      sessionId: "same-connection-removed",
      updatedAt: 1,
    });
    const before = listSessionEntries({ ...scope, clone: false, projection: "list" });
    const keptProjection = before.find((row) => row.sessionKey === scope.sessionKey)?.entry;

    const database = openOpenClawAgentDatabase(scope);
    const insertedKey = "agent:main:same-connection-inserted";
    const insertedEntry = {
      label: "projection-probe-inserted",
      sessionId: "same-connection-inserted",
      updatedAt: 2,
    };
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        insertedKey,
        insertedEntry.sessionId,
        JSON.stringify(insertedEntry),
        insertedEntry.updatedAt,
      );
    database.db
      .prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run(removedScope.sessionKey);

    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();
    const entries = listSessionEntries({ ...scope, clone: false, projection: "list" });

    expect(entries.map((row) => row.sessionKey)).toEqual(
      [scope.sessionKey, insertedKey].toSorted(),
    );
    expect(entries.find((row) => row.sessionKey === scope.sessionKey)?.entry).toBe(keptProjection);
    expect(entries.find((row) => row.sessionKey === insertedKey)?.entry).toMatchObject(
      insertedEntry,
    );
    expect(parseSessionEntryCalls).toHaveBeenCalledOnce();
    expect(listProjectionCalls).toHaveBeenCalledOnce();
  });

  it("scales parse and projection work with changed keys instead of store size", async () => {
    const scope = createSessionScope("changed-key-scaling");
    const rowCount = 24;
    for (let index = 0; index < rowCount; index++) {
      await upsertSessionEntry(
        { ...scope, sessionKey: `agent:main:changed-key-scaling-${index}` },
        {
          label: `projection-probe-${index}`,
          sessionId: `changed-key-scaling-${index}`,
          updatedAt: index + 1,
        },
      );
    }
    listSessionEntries({ ...scope, clone: false, projection: "list" });

    const database = openOpenClawAgentDatabase(scope);
    for (const index of [3, 19]) {
      const sessionKey = `agent:main:changed-key-scaling-${index}`;
      const entry = {
        label: `projection-probe-changed-${index}`,
        sessionId: `changed-key-scaling-${index}`,
        updatedAt: 1_000 + index,
      };
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = ?, label = ?, updated_at = ? WHERE session_key = ?",
        )
        .run(JSON.stringify(entry), entry.label, entry.updatedAt, sessionKey);
    }
    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();

    const entries = listSessionEntries({ ...scope, clone: false, projection: "list" });

    expect(entries).toHaveLength(rowCount);
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
    expect(listProjectionCalls).toHaveBeenCalledTimes(2);
  });

  it("patches only the tracked row after a same-process upsert", async () => {
    const scope = createSessionScope("write-through");
    const siblingScope = { ...scope, sessionKey: "agent:main:write-through-sibling" };
    await upsertSessionEntry(scope, {
      label: "projection-probe-before",
      sessionId: "write-through",
      updatedAt: 1,
    });
    await upsertSessionEntry(siblingScope, {
      label: "projection-probe-sibling",
      sessionId: "write-through-sibling",
      updatedAt: 1,
    });
    const before = listSessionEntries({ ...scope, clone: false, projection: "list" });
    const siblingBefore = before.find((row) => row.sessionKey === siblingScope.sessionKey)?.entry;

    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();
    await upsertSessionEntry(scope, { label: "projection-probe-after", updatedAt: 2 });
    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();
    const after = listSessionEntries({ ...scope, clone: false, projection: "list" });

    expect(after.find((row) => row.sessionKey === scope.sessionKey)?.entry.label).toBe(
      "projection-probe-after",
    );
    expect(after.find((row) => row.sessionKey === siblingScope.sessionKey)?.entry).toBe(
      siblingBefore,
    );
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    expect(listProjectionCalls).toHaveBeenCalledOnce();
  });

  it("adds a tracked upsert to a warm snapshot without reparsing siblings", async () => {
    const scope = createSessionScope("write-through-insert");
    await upsertSessionEntry(scope, {
      label: "projection-probe-existing",
      sessionId: "write-through-existing",
      updatedAt: 1,
    });
    const existing = listSessionEntries({ ...scope, clone: false, projection: "list" })[0]?.entry;
    const insertedScope = { ...scope, sessionKey: "agent:main:write-through-inserted" };

    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();
    await upsertSessionEntry(insertedScope, {
      label: "projection-probe-inserted",
      sessionId: "write-through-inserted",
      updatedAt: 2,
    });
    parseSessionEntryCalls.mockClear();
    listProjectionCalls.mockClear();
    const after = listSessionEntries({ ...scope, clone: false, projection: "list" });

    expect(after.map((row) => row.sessionKey)).toEqual(
      [scope.sessionKey, insertedScope.sessionKey].toSorted(),
    );
    expect(after.find((row) => row.sessionKey === scope.sessionKey)?.entry).toBe(existing);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    expect(listProjectionCalls).toHaveBeenCalledOnce();
  });

  it("does not let a tracked write mask an earlier raw connection write", async () => {
    const scope = createSessionScope("raw-before-tracked");
    const trackedScope = { ...scope, sessionKey: "agent:main:tracked-after-raw" };
    await upsertSessionEntry(scope, { label: "raw-before", sessionId: "raw", updatedAt: 1 });
    await upsertSessionEntry(trackedScope, {
      label: "tracked-before",
      sessionId: "tracked",
      updatedAt: 1,
    });
    listSessionEntries(scope);

    const database = openOpenClawAgentDatabase(scope);
    const rawEntry = { label: "raw-after", sessionId: "raw", updatedAt: Date.now() };
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(rawEntry), rawEntry.updatedAt, scope.sessionKey);
    await upsertSessionEntry(trackedScope, { label: "tracked-after", updatedAt: 2 });

    parseSessionEntryCalls.mockClear();
    const entries = listSessionEntries(scope);
    const entriesBySessionId = new Map(entries.map((row) => [row.entry.sessionId, row.entry]));

    expect(entriesBySessionId.get("raw")).toMatchObject(rawEntry);
    expect(entriesBySessionId.get("tracked")).toMatchObject({
      label: "tracked-after",
      sessionId: "tracked",
    });
    expect(parseSessionEntryCalls).toHaveBeenCalledOnce();
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

  it("bypasses the cache in a transaction and reuses the persisted snapshot after rollback", async () => {
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
    expect(borrowedAfter).toStrictEqual(borrowedBefore);
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
    expect(view.get(scope.sessionKey)).toStrictEqual(first);
    expect(view.entries()[0]?.entry).toStrictEqual(first);
  });

  it("honors latest reads after an untracked own-connection write", async () => {
    const scope = createSessionScope("latest");
    await upsertSessionEntry(scope, { label: "cached", sessionId: "latest", updatedAt: 1 });
    expect(loadSessionEntry(scope)?.label).toBe("cached");

    const database = openOpenClawAgentDatabase(scope);
    const updated = { label: "latest", sessionId: "latest", updatedAt: 2 };
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(updated), updated.updatedAt, scope.sessionKey);

    expect(loadSessionEntry(scope)?.label).toBe("latest");
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })?.label).toBe("latest");
  });
});
