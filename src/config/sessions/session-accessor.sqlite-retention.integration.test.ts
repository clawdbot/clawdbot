import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import {
  appendTranscriptEventSync,
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

it("expires a real deleted archive and SQLite recovery row while retaining a reset archive", async () => {
  const tempDir = tempDirs.make("openclaw-session-retention-integration-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const deletedSession = {
    sessionId: "integration-deleted",
    sessionKey: "agent:main:integration-deleted",
    storePath,
  };
  await replaceSessionEntry(deletedSession, { sessionId: deletedSession.sessionId, updatedAt: 1 });
  appendTranscriptEventSync(deletedSession, {
    type: "proof",
    content: "real archive payload",
  });

  const deleted = await deleteSessionEntryLifecycle({
    archiveTranscript: true,
    storePath,
    target: { canonicalKey: deletedSession.sessionKey, storeKeys: [deletedSession.sessionKey] },
  });
  const originalArchivePath = deleted.archivedTranscripts[0]?.archivedPath;
  if (!originalArchivePath) {
    throw new Error("expected a real deleted archive file");
  }

  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
  if (!sqlitePath) {
    throw new Error("expected SQLite session store");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
  const archiveRow = database.db
    .prepare(
      "SELECT archive_name FROM session_transcript_archives WHERE session_id = ? AND reason = 'deleted'",
    )
    .get(deletedSession.sessionId) as { archive_name: string } | undefined;
  if (!archiveRow) {
    throw new Error("expected a published deleted archive row");
  }

  const oldStamp = formatSessionArchiveTimestamp(1);
  const oldArchiveName = archiveRow.archive_name.replace(/\.deleted\..+$/, `.deleted.${oldStamp}`);
  const oldArchivePath = path.join(path.dirname(originalArchivePath), oldArchiveName);
  fs.renameSync(originalArchivePath, oldArchivePath);
  database.db
    .prepare(
      "UPDATE session_transcript_archives SET archive_name = ?, created_at = 1 WHERE session_id = ? AND reason = 'deleted'",
    )
    .run(oldArchiveName, deletedSession.sessionId);

  const resetArchiveName = `integration-reset.jsonl.reset.${formatSessionArchiveTimestamp(Date.now())}`;
  const resetArchivePath = path.join(path.dirname(storePath), resetArchiveName);
  fs.writeFileSync(resetArchivePath, "reset history\n");
  const liveSessionKey = "agent:main:integration-live";
  await replaceSessionEntry(
    { sessionKey: liveSessionKey, storePath },
    { sessionId: "integration-live", updatedAt: Date.now() },
  );

  await applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      mode: "enforce",
      pruneAfterMs: Number.MAX_SAFE_INTEGER,
      resetArchiveRetentionMs: 7 * 24 * 60 * 60 * 1000,
      deletedArchiveRetentionMs: 1,
    },
    upserts: [
      {
        sessionKey: liveSessionKey,
        entry: { sessionId: "integration-live", updatedAt: Date.now() },
      },
    ],
  });

  expect(fs.existsSync(oldArchivePath)).toBe(false);
  expect(fs.existsSync(resetArchivePath)).toBe(true);
  expect(
    database.db
      .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
      .get(deletedSession.sessionId),
  ).toBeUndefined();
  console.info(
    "retention-proof",
    JSON.stringify({ deletedArchiveFile: false, deletedArchiveRow: false, resetArchiveFile: true }),
  );
});
