import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { materializeTranscriptArchiveInWorker } from "./session-accessor.sqlite-archive.worker.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const BATCHED_TRANSCRIPT_EVENT_COUNT = 33;

describe("SQLite transcript archive worker concurrency", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-sqlite-archive-concurrency-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("allows a rollback-journal writer between bounded archive batches", async () => {
    const sessionId = "rollback-reader-session";
    const sessionKey = "agent:main:rollback-reader";
    const concurrentSessionKey = "agent:main:rollback-writer";
    await createBatchedTranscript({ sessionId, sessionKey, storePath });
    await replaceSessionEntry(
      { sessionKey: concurrentSessionKey, storePath },
      { sessionId: "rollback-writer-session", updatedAt: Date.now() },
    );

    const database = openLifecycleTestDatabase(storePath);
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    expect(database.db.prepare("PRAGMA journal_mode = DELETE;").get()).toEqual({
      journal_mode: "delete",
    });
    let batchesRead = 0;
    let concurrentWriteCompleted = false;

    const result = await materializeTranscriptArchiveInWorker(
      planArchiveWorker(database, path.dirname(storePath), sessionId),
      {
        afterBatchRead: (batchIndex) => {
          batchesRead += 1;
          if (batchIndex !== 0) {
            return;
          }
          const writer = new DatabaseSync(database.path);
          try {
            writer.exec("PRAGMA busy_timeout = 250;");
            const writeResult = writer
              .prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
              .run(concurrentSessionKey);
            expect(writeResult.changes).toBe(1);
            concurrentWriteCompleted = true;
          } finally {
            writer.close();
          }
        },
      },
    );

    expect(result.archivedPath).not.toBeNull();
    expect(batchesRead).toBe(3);
    expect(concurrentWriteCompleted).toBe(true);
  });

  it("does not pin a WAL read snapshot between bounded archive batches", async () => {
    const sessionId = "wal-reader-session";
    const sessionKey = "agent:main:wal-reader";
    const concurrentSessionKey = "agent:main:wal-writer";
    await createBatchedTranscript({ sessionId, sessionKey, storePath });
    await replaceSessionEntry(
      { sessionKey: concurrentSessionKey, storePath },
      { sessionId: "wal-writer-session", updatedAt: Date.now() },
    );

    const database = openLifecycleTestDatabase(storePath);
    expect(database.db.prepare("PRAGMA journal_mode = WAL;").get()).toEqual({
      journal_mode: "wal",
    });
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    let checkpoint: Record<string, unknown> | undefined;

    const result = await materializeTranscriptArchiveInWorker(
      planArchiveWorker(database, path.dirname(storePath), sessionId),
      {
        afterBatchRead: (batchIndex) => {
          if (batchIndex !== 0) {
            return;
          }
          const writer = new DatabaseSync(database.path);
          try {
            writer.exec("PRAGMA busy_timeout = 250;");
            const writeResult = writer
              .prepare("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = ?")
              .run(concurrentSessionKey);
            expect(writeResult.changes).toBe(1);
            checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
          } finally {
            writer.close();
          }
        },
      },
    );

    expect(result.archivedPath).not.toBeNull();
    expect(checkpoint).toEqual({ busy: 0, checkpointed: 0, log: 0 });
  });

  it("rejects transcript mutation between archive batches before publication", async () => {
    const sessionId = "changed-between-batches-session";
    const sessionKey = "agent:main:changed-between-batches";
    await createBatchedTranscript({ sessionId, sessionKey, storePath });
    const database = openLifecycleTestDatabase(storePath);
    const archiveDirectory = path.dirname(storePath);
    let mutationCount = 0;

    await expect(
      materializeTranscriptArchiveInWorker(
        planArchiveWorker(database, archiveDirectory, sessionId),
        {
          afterBatchRead: (batchIndex) => {
            if (batchIndex !== 0) {
              return;
            }
            mutationCount += 1;
            runOpenClawAgentWriteTransaction(
              (transactionDb) => {
                const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(transactionDb.db);
                executeSqliteQuerySync(
                  transactionDb.db,
                  db
                    .updateTable("transcript_events")
                    .set({ event_json: createTranscriptEventLine(sessionId, "changed after read") })
                    .where("session_id", "=", sessionId)
                    .where("seq", "=", 0),
                );
                touchTranscriptMutationInTransaction(transactionDb, sessionId);
              },
              { agentId: database.agentId, path: database.path },
            );
          },
        },
      ),
    ).rejects.toThrow(
      `SQLite session state changed during archive materialization for ${sessionId}`,
    );

    expect(mutationCount).toBe(1);
    expect(findArchiveEntries(archiveDirectory, sessionId)).toEqual([]);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const retained = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select("event_json")
        .where("session_id", "=", sessionId)
        .where("seq", "=", 0),
    ).rows[0];
    expect(retained?.event_json).toBe(createTranscriptEventLine(sessionId, "changed after read"));
  });
});

async function createBatchedTranscript(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  await replaceTranscriptEvents(
    { sessionId: params.sessionId, sessionKey: params.sessionKey, storePath: params.storePath },
    Array.from({ length: BATCHED_TRANSCRIPT_EVENT_COUNT }, (_, index) => ({
      content: `event-${index}`,
      id: `${params.sessionId}-${index}`,
      type: "session",
    })),
  );
}

function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({ type: "session", id: sessionId, content });
}

function findArchiveEntries(archiveDirectory: string, sessionId: string): string[] {
  return fs
    .readdirSync(archiveDirectory)
    .filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`));
}

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
}

function planArchiveWorker(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  archiveDirectory: string,
  sessionId: string,
) {
  const plan = planSessionStateDeleteIfUnreferenced({
    archiveDirectory,
    database,
    referencedSessionIds: new Set(),
    sessionId,
  });
  if (!plan) {
    throw new Error(`expected an archive plan for ${sessionId}`);
  }
  return plan;
}
