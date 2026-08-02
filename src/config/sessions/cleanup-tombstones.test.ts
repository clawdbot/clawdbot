import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { sweepTombstonedCronRunRemnants } from "./cleanup-tombstones.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { deleteSqliteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { planSqliteSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const materializedHook = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSqliteSessionStateDeletePlans: (
      plans: Parameters<typeof actual.materializeSqliteSessionStateDeletePlans>[0],
    ) => {
      const materialized = actual.materializeSqliteSessionStateDeletePlans(plans);
      materializedHook.run?.();
      return materialized;
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 7, 1, 0, 0, 0);
const CRON_RUN_KEY = "agent:main:cron:job-1:run:run-1";

describe("sweepTombstonedCronRunRemnants", () => {
  let tempDir: string;
  let storePath: string;
  let sqlitePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-tombstone-sweep-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(() => {
    materializedHook.run = undefined;
    delete process.env.OPENCLAW_STATE_DIR;
    closeOpenClawAgentDatabasesForTest();
  });

  function openDatabase() {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected sqlite database path");
    }
    sqlitePath = databasePath;
    return openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  }

  async function seedCanonicalPlaceholder(params: {
    ageMs?: number;
    key?: string;
    sessionId?: string;
  }): Promise<string> {
    const key = params.key ?? CRON_RUN_KEY;
    const sessionId = params.sessionId ?? "cron-session";
    await replaceSessionEntry({ sessionKey: key, storePath }, { sessionId, updatedAt: NOW_MS });
    await replaceSqliteTranscriptEvents({ sessionKey: key, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "cron run transcript" },
    ]);
    const database = openDatabase();
    deleteSqliteSessionEntryRows(database, key);
    const updatedAt = NOW_MS - (params.ageMs ?? 20 * DAY_MS);
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ updated_at: updatedAt })
        .where("session_key", "=", key),
    );
    executeSqliteQuerySync(
      database.db,
      db.updateTable("session_nodes").set({ updated_at: updatedAt }).where("session_key", "=", key),
    );
    executeSqliteQuerySync(
      database.db,
      db.updateTable("session_nodes").set({ entry_valid: -1 }).where("session_key", "=", key),
    );
    return sessionId;
  }

  function sweep(params: {
    dryRun: boolean;
    olderThanMs?: number;
    includeUnidentifiedPlaceholders?: boolean;
  }) {
    return sweepTombstonedCronRunRemnants({
      agentId: "main",
      storePath,
      sqlitePath,
      olderThanMs: params.olderThanMs ?? 15 * DAY_MS,
      dryRun: params.dryRun,
      ...(params.includeUnidentifiedPlaceholders === undefined
        ? {}
        : { includeUnidentifiedPlaceholders: params.includeUnidentifiedPlaceholders }),
      nowMs: NOW_MS,
    });
  }

  /**
   * Same shape as a canonical placeholder except `entry_json`, which the
   * canonical predicate requires to be exactly "{}". This is the row class the
   * superseded fix/session-node-orphan-cleanup branch reaped and the canonical
   * sweep deliberately preserves.
   */
  async function seedUnidentifiedPlaceholder(params: { ageMs?: number } = {}): Promise<string> {
    const sessionId = await seedCanonicalPlaceholder({ ageMs: params.ageMs });
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_json: JSON.stringify({ delivery: { kind: "none" } }) })
        .where("session_key", "=", CRON_RUN_KEY),
    );
    return sessionId;
  }

  function countRows(
    table: "session_nodes" | "session_windows" | "transcript_events",
    column: "session_key" | "session_id",
    value: string,
  ): number {
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db.selectFrom(table).select(column).where(column, "=", value),
    ).rows.length;
  }

  function archiveNames(sessionId: string): string[] {
    try {
      return fs
        .readdirSync(path.dirname(storePath))
        .filter((name) => name.startsWith(`${sessionId}.jsonl.deleted.`));
    } catch {
      return [];
    }
  }

  it("archives and deletes an expired canonical cron-run placeholder", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const database = openDatabase();
    expect(
      database.db
        .prepare(
          "SELECT current_session_id, entry_json, entry_valid FROM session_nodes WHERE session_key = ?",
        )
        .get(CRON_RUN_KEY),
    ).toEqual({
      current_session_id: sessionId,
      entry_json: "{}",
      entry_valid: -1,
    });

    await expect(sweep({ dryRun: true })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 1,
      sweptTranscriptStates: 1,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(0);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(0);
    const archives = archiveNames(sessionId);
    expect(archives).toHaveLength(1);
    expect(
      readSessionArchiveContentSync(path.join(path.dirname(storePath), archives[0] ?? "")),
    ).toContain("cron run transcript");

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 0,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(archiveNames(sessionId)).toEqual(archives);
  });

  it("uses the newest owned window timestamp for the retention gate", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ updated_at: NOW_MS - DAY_MS })
        .where("session_id", "=", sessionId),
    );

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 0,
      removedNodes: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
  });

  it("preserves the whole placeholder when another live entry references its generation", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    await replaceSessionEntry(
      { sessionKey: "agent:main:direct:survivor", storePath },
      {
        previousSessionId: sessionId,
        sessionId: "survivor-session",
        updatedAt: NOW_MS,
      },
    );

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual([]);
  });

  it("removes a new archive when final revalidation finds a late live reference", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    materializedHook.run = () => {
      const database = openDatabase();
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("session_nodes").values({
          session_key: "agent:main:direct:late-reference",
          current_session_id: sessionId,
          entry_json: "{}",
          updated_at: NOW_MS,
        }),
      );
    };

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("session_windows", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual([]);
  });

  it("keeps a reused archive when final revalidation finds a late live reference", async () => {
    const sessionId = await seedCanonicalPlaceholder({});
    const database = openDatabase();
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      archiveTranscript: true,
      database,
      reason: "deleted",
      referencedSessionIds: new Set(),
      sessionId,
    });
    expect(plan).not.toBeNull();
    materializeSqliteSessionStateDeletePlans(plan ? [plan] : []);
    const existingArchives = archiveNames(sessionId);
    expect(existingArchives).toHaveLength(1);
    materializedHook.run = () => {
      const currentDatabase = openDatabase();
      const db = getSessionKysely(currentDatabase.db);
      executeSqliteQuerySync(
        currentDatabase.db,
        db.insertInto("session_nodes").values({
          session_key: "agent:main:direct:late-reference",
          current_session_id: sessionId,
          entry_json: "{}",
          updated_at: NOW_MS,
        }),
      );
    };

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 1,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
    expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    expect(archiveNames(sessionId)).toEqual(existingArchives);
  });

  it("preserves malformed and non-cron rows instead of treating parser failure as debris", async () => {
    const cases = [
      {
        key: "agent:main:cron:job-2:run:invalid-json",
        entryJson: "{",
        entryValid: -1,
        currentSessionId: "invalid-json",
      },
      {
        key: "agent:main:cron:job-2:run:invalid-marker",
        entryJson: "{}",
        entryValid: 0,
        currentSessionId: "invalid-marker",
      },
      {
        key: "agent:main:cron:job-2:run:missing-window",
        entryJson: "{}",
        entryValid: -1,
        currentSessionId: "different-session",
      },
      {
        key: "agent:main:direct:not-cron",
        entryJson: "{}",
        entryValid: -1,
        currentSessionId: "not-cron",
      },
    ] as const;

    for (const testCase of cases) {
      const sessionId = await seedCanonicalPlaceholder({
        key: testCase.key,
        sessionId: testCase.key.split(":").at(-1),
      });
      const database = openDatabase();
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_nodes")
          .set({
            current_session_id: testCase.currentSessionId,
            entry_json: testCase.entryJson,
          })
          .where("session_key", "=", testCase.key),
      );
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_nodes")
          .set({ entry_valid: testCase.entryValid })
          .where("session_key", "=", testCase.key),
      );
      expect(countRows("transcript_events", "session_id", sessionId)).toBe(1);
    }

    await expect(sweep({ dryRun: false })).resolves.toMatchObject({
      candidates: 0,
      removedNodes: 0,
      sweptTranscriptStates: 0,
    });
    for (const testCase of cases) {
      expect(countRows("session_nodes", "session_key", testCase.key)).toBe(1);
      expect(countRows("session_windows", "session_key", testCase.key)).toBe(1);
    }
  });

  it("preserves an unidentifiable aged cron row by default", async () => {
    await seedUnidentifiedPlaceholder();

    const result = await sweep({ dryRun: true });

    expect(result).toMatchObject({ candidates: 0, unidentifiedCandidates: 0 });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
  });

  it("reaps an unidentifiable aged cron row when explicitly opted in", async () => {
    await seedUnidentifiedPlaceholder();

    const dry = await sweep({ dryRun: true, includeUnidentifiedPlaceholders: true });
    expect(dry).toMatchObject({
      candidates: 1,
      unidentifiedCandidates: 1,
      removedNodes: 0,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);

    const applied = await sweep({ dryRun: false, includeUnidentifiedPlaceholders: true });
    expect(applied).toMatchObject({
      candidates: 1,
      unidentifiedCandidates: 1,
      removedNodes: 1,
    });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(0);
  });

  it("keeps the age gate under the unidentified opt-in", async () => {
    await seedUnidentifiedPlaceholder({ ageMs: 2 * DAY_MS });

    const result = await sweep({ dryRun: true, includeUnidentifiedPlaceholders: true });

    expect(result).toMatchObject({ candidates: 0, unidentifiedCandidates: 0 });
    expect(countRows("session_nodes", "session_key", CRON_RUN_KEY)).toBe(1);
  });

  it("reports canonical sweeps as identified even with the opt-in on", async () => {
    await seedCanonicalPlaceholder({});

    const result = await sweep({ dryRun: true, includeUnidentifiedPlaceholders: true });

    expect(result).toMatchObject({ candidates: 1, unidentifiedCandidates: 0 });
  });
});
