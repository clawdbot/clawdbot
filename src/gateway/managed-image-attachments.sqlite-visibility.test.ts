import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import {
  publishEncodedSessionTranscriptArchive,
  resolveSqliteTranscriptArchivePath,
} from "../config/sessions/session-accessor.sqlite-archive.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  cleanupManagedOutgoingMediaRecords,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import {
  readSessionMessageCountAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timestamp = "2026-09-04T00:00:00.000Z";
let stateDir: string;
let savedEnv: ReturnType<typeof captureEnv>;

function message(id: string, parentId: string | null, content: unknown) {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", content } };
}

async function fixture() {
  const sessionId = `managed-visibility-${randomUUID()}`;
  const sessionKey = `agent:main:${sessionId}`;
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const scope = { agentId: "main", sessionId, sessionKey, storePath };
  await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
  const attachmentId = randomUUID();
  const body = Buffer.from("synthetic managed original\n");
  const mediaRoot = path.join(stateDir, "media");
  const mediaId = `${attachmentId}.png`;
  const originalPath = path.join(mediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR, mediaId);
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.writeFileSync(originalPath, body);
  const messageId = "attached";
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      agentId: "main",
      messageId,
      createdAt: timestamp,
      alt: "Synthetic attachment",
      original: {
        mediaRoot,
        mediaId,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: "image/png",
        width: 1,
        height: 1,
        sizeBytes: body.length,
        filename: "fixture.png",
      },
    },
    stateDir,
  );
  const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
  const block = { type: "image", url, openUrl: url };
  const download = () =>
    resolveManagedOutgoingMediaArtifactDownload({
      sessionKey,
      agentId: "main",
      stateDir,
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
    });
  return { scope, attachmentId, messageId, originalPath, block, download };
}

async function seed(f: Awaited<ReturnType<typeof fixture>>, events: unknown[]) {
  await replaceTranscriptEvents(f.scope, [
    { type: "session", version: 3, id: f.scope.sessionId, timestamp, cwd: stateDir },
    ...events,
  ]);
  await readSessionMessageCountAsync(f.scope);
}

function archive(f: Awaited<ReturnType<typeof fixture>>) {
  const bytes = Buffer.from(
    [
      { type: "session", version: 3, id: f.scope.sessionId, timestamp, cwd: stateDir },
      message(f.messageId, null, [f.block]),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const archiveDirectory = path.dirname(f.scope.storePath);
  const archiveName = path.basename(
    resolveSqliteTranscriptArchivePath({
      archiveDirectory,
      identityOwner: "filename",
      sessionId: f.scope.sessionId,
      reason: "reset",
      nowMs: Date.parse(timestamp),
    }),
  );
  return publishEncodedSessionTranscriptArchive({
    archiveDirectory,
    archiveName,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

beforeEach(() => {
  savedEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
  stateDir = fs.realpathSync(tempDirs.make("managed-visibility-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({ agents: { list: [{ id: "main" }] } });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  savedEnv.restore();
});

describe("managed attachment SQLite visibility", () => {
  it.each(["fresh-message", "reset-only", "inactive-branch"] as const)(
    "rechecks archive membership after the active history becomes %s",
    async (kind) => {
      const f = await fixture();
      await seed(f, []);
      const archivePath = archive(f);
      const archiveBefore = fs.readFileSync(archivePath);
      expect((await f.download()) !== null).toBe(true);
      const root = message("root", null, "root");
      const replacement = message("replacement", "root", "fresh history");
      const events =
        kind === "fresh-message"
          ? [root, replacement]
          : kind === "reset-only"
            ? [
                message(f.messageId, null, [f.block]),
                { type: "reset", id: "reset", parentId: f.messageId, timestamp, reason: "new" },
              ]
            : [root, message(f.messageId, "root", [f.block]), replacement];
      await seed(f, events);
      const full = await readSessionMessagesWithSourceAsync(f.scope, {
        mode: "full",
        reason: "managed attachment visibility",
        allowResetArchiveFallback: true,
      });
      expect(
        full.messages.map((m) => (m as { __openclaw?: { id?: string } })["__openclaw"]?.id),
      ).toEqual(kind === "reset-only" ? ["reset"] : ["root", "replacement"]);
      expect((await f.download()) === null).toBe(true);
      expect(
        await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
      ).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
      expect(readManagedImageRecord(f.attachmentId, stateDir)).toBeNull();
      expect(fs.existsSync(f.originalPath)).toBe(false);
      expect(fs.readFileSync(archivePath)).toEqual(archiveBefore);
    },
  );

  it.each(["selected", "unrelated", "unrelated-missing"] as const)(
    "retains records when %s history JSON is malformed",
    async (fault) => {
      const f = await fixture();
      await seed(f, [
        message("unrelated", null, "unrelated content"),
        ...(fault === "unrelated-missing" ? [] : [message(f.messageId, "unrelated", [f.block])]),
      ]);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db
        .prepare(`UPDATE transcript_events SET event_json = '{malformed' WHERE session_id = ? AND seq = (
        SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?
      )`)
        .run(
          f.scope.sessionId,
          f.scope.sessionId,
          fault === "selected" ? f.messageId : "unrelated",
        );
      await expect(f.download()).rejects.toBeInstanceOf(SyntaxError);
      await expect(
        cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(readManagedImageRecord(f.attachmentId, stateDir)).not.toBeNull();
      expect(fs.existsSync(f.originalPath)).toBe(true);
    },
  );
});
