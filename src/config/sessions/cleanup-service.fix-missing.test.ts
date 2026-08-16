import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { isRetainedSessionTranscriptArchiveName } from "./artifacts.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  applySessionEntryLifecycleMutation,
  inspectTranscriptEventsSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";
import { prunePublishedSessionArchivesByRetention } from "./session-accessor.sqlite-archive-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function listDeletedArchives(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter(isRetainedSessionTranscriptArchiveName)
    .map((entry) => path.join(directory, entry));
}

describe("sessions cleanup --fix-missing", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-cleanup-fix-missing-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("preserves readable session state when a later transcript row is malformed", async () => {
    const sessionKey = "agent:main:malformed-after-message";
    const sessionId = "malformed-after-message";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      eventId: "readable-user-message",
      message: { role: "user", content: [{ type: "text", text: "keep this conversation" }] },
    });
    appendTranscriptEventSync(scope, { type: "proof", id: "row-to-corrupt" });

    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db
      .prepare(
        `UPDATE transcript_events
         SET event_json = '{malformed'
         WHERE session_id = ? AND seq = (
           SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
         )`,
      )
      .run(sessionId, sessionId);

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(result.appliedSummaries[0]?.missing).toBe(0);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
  });

  it("archives raw non-message rows before removing a confirmed missing session", async () => {
    const sessionKey = "agent:main:message-free";
    const sessionId = "message-free";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, {
      type: "proof",
      id: "raw-event",
      content: "recoverable non-message state",
    });
    const rawEventJson =
      '{  "content": "recoverable non-message state", "id": "raw-event", "type": "proof"  }';
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
      .db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
      .run(rawEventJson, sessionId);

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(result.appliedSummaries[0]?.missing).toBe(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    const archives = listDeletedArchives(path.dirname(storePath));
    expect(archives).toHaveLength(1);
    expect(readSessionArchiveContentSync(archives[0] ?? "")).toBe(`${rawEventJson}\n`);
    expect(
      openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
        .db.prepare(
          `SELECT session_key, reason, published_at
           FROM session_transcript_archives WHERE session_id = ?`,
        )
        .get(sessionId),
    ).toMatchObject({
      published_at: expect.any(Number),
      reason: "deleted",
      session_key: sessionKey,
    });
  });

  it("recreates every derived file from pending canonical archives after commit", async () => {
    const sessionIds = Array.from({ length: 6 }, (_, index) => `pending-export-${index}`);
    for (const sessionId of sessionIds) {
      const scope = {
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath,
      };
      await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      appendTranscriptEventSync(scope, {
        type: "proof",
        content: `recover after commit ${sessionId}`,
      });
    }

    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    const archives = listDeletedArchives(path.dirname(storePath));
    expect(archives).toHaveLength(sessionIds.length);
    for (const archivePath of archives) {
      fs.rmSync(archivePath);
    }
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
      .db.prepare(
        `UPDATE session_transcript_archives
         SET published_at = NULL, last_publish_error = 'simulated crash'`,
      )
      .run();

    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    const recovered = listDeletedArchives(path.dirname(storePath));
    expect(recovered).toHaveLength(sessionIds.length);
    for (const sessionId of sessionIds) {
      const archivePath = recovered.find((candidate) =>
        path.basename(candidate).startsWith(`${sessionId}.jsonl.deleted.`),
      );
      expect(archivePath).toBeTruthy();
      expect(readSessionArchiveContentSync(archivePath ?? "")).toContain(
        `recover after commit ${sessionId}`,
      );
    }
    const statuses = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
      .db.prepare(
        `SELECT session_id, published_at, publish_attempts, last_publish_error
         FROM session_transcript_archives ORDER BY session_id`,
      )
      .all();
    expect(statuses).toHaveLength(sessionIds.length);
    for (const status of statuses) {
      expect(status).toMatchObject({
        last_publish_error: null,
        publish_attempts: 2,
        published_at: expect.any(Number),
      });
    }
  });

  it("never overwrites a different derived-file collision", async () => {
    const sessionKey = "agent:main:collision";
    const sessionId = "collision";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", content: "canonical bytes" });
    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });
    const archivePath = listDeletedArchives(path.dirname(storePath))[0];
    expect(archivePath).toBeTruthy();
    fs.writeFileSync(archivePath ?? "", "different bytes", "utf8");
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db
      .prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(sessionId);

    await expect(
      runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: [{ agentId: "main", storePath }],
      }),
    ).rejects.toThrow("remain pending in SQLite");

    expect(fs.readFileSync(archivePath ?? "", "utf8")).toBe("different bytes");
    expect(
      database.db
        .prepare(
          "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionId),
    ).toMatchObject({
      last_publish_error: expect.stringContaining("collision"),
      published_at: null,
    });
  });

  it("rolls back the canonical archive when lifecycle deletion fails", async () => {
    const sessionKey = "agent:main:rollback-delete";
    const sessionId = "rollback-delete";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", content: "must remain live" });
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db.exec(`
      CREATE TRIGGER fail_session_window_delete
      BEFORE DELETE ON session_windows
      WHEN OLD.session_id = '${sessionId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected lifecycle delete failure');
      END;
    `);

    await expect(
      runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: [{ agentId: "main", storePath }],
      }),
    ).rejects.toThrow("injected lifecycle delete failure");

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(
      database.db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ?").get(sessionId),
    ).toEqual({ 1: 1 });
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toBeUndefined();
    expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
  });

  it("omits a cleanup removal whose transcript classification became stale", async () => {
    const sessionKey = "agent:main:stale-classification";
    const sessionId = "stale-classification";
    const scope = { sessionKey, sessionId, storePath };
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry(scope, entry);
    const observation = inspectTranscriptEventsSync(scope).snapshot;
    appendTranscriptMessageSync(scope, {
      eventId: "message-after-classification",
      message: { role: "user", content: [{ type: "text", text: "now live" }] },
    });

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          sessionKey,
          expectedEntry: entry,
          expectedTranscriptSnapshot: observation,
          archiveRemovedTranscript: true,
        },
      ],
      skipMaintenance: true,
    });

    expect(result.removedSessionKeys).toEqual([]);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
  });

  it("drops a retained canonical row only after retention removes its derived file", async () => {
    const sessionKey = "agent:main:retention";
    const sessionId = "retention";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", content: "expire together" });
    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });
    const archivePath = listDeletedArchives(path.dirname(storePath))[0];
    expect(archivePath).toBeTruthy();
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db
      .prepare("UPDATE session_transcript_archives SET created_at = 1 WHERE session_id = ?")
      .run(sessionId);

    expect(
      await prunePublishedSessionArchivesByRetention({
        scope: { agentId: "main", path: sqlitePath },
        rules: [{ reason: "deleted", olderThanMs: 10 }],
        nowMs: 100,
      }),
    ).toBe(0);
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ 1: 1 });

    fs.rmSync(archivePath ?? "");
    expect(
      await prunePublishedSessionArchivesByRetention({
        scope: { agentId: "main", path: sqlitePath },
        rules: [{ reason: "deleted", olderThanMs: 10 }],
        nowMs: 100,
      }),
    ).toBe(1);
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toBeUndefined();
  });
});
