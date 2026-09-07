import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import { appendSessionTranscriptMessageByIdentity } from "../plugin-sdk/session-transcript-runtime.js";
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
  readSessionMessagesMatchingIdAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timestamp = "2026-09-04T00:00:00.000Z";
let stateDir: string;
let savedEnv: ReturnType<typeof captureEnv>;

function message(id: string, parentId: string | null, content: unknown) {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", content } };
}

async function fixture(messageId = "attached") {
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

function archive(
  f: Awaited<ReturnType<typeof fixture>>,
  events: unknown[] = [message(f.messageId, null, [f.block])],
) {
  const bytes = Buffer.from(
    [{ type: "session", version: 3, id: f.scope.sessionId, timestamp, cwd: stateDir }, ...events]
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
  it("does not decode every unrelated payload when resolving one attachment", async () => {
    const f = await fixture();
    const marker = "managed-membership-wide-payload";
    const text = marker + "x".repeat(16 * 1024);
    const unrelated = Array.from({ length: 40 }, (_, index) =>
      message(`other-${index}`, index === 0 ? null : `other-${index - 1}`, [
        { type: "text", text },
      ]),
    );
    await seed(f, [...unrelated, message(f.messageId, "other-39", [f.block])]);
    const parse = JSON.parse;
    let decodedUnrelatedPayloads = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (typeof value === "string" && value.includes(marker)) {
        decodedUnrelatedPayloads += 1;
      }
      return parse(value, reviver);
    });
    try {
      expect((await f.download())?.artifactId).toBe(
        `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${f.attachmentId}`,
      );
      // One payload can establish nonempty display history; the requested record
      // must not require decoding the remaining unrelated message bodies.
      expect(decodedUnrelatedPayloads).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([" padded-id ", "   "])("preserves raw message ID %j", async (messageId) => {
    const f = await fixture(messageId);
    await seed(f, [message(messageId, null, [f.block])]);
    const full = await readSessionMessagesWithSourceAsync(f.scope, {
      mode: "full",
      reason: "raw managed attachment identity",
      allowResetArchiveFallback: true,
    });
    expect(full.messages).toMatchObject([{ __openclaw: { id: messageId } }]);
    expect((await f.download())?.artifactId).toBe(
      `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${f.attachmentId}`,
    );
  });

  it.each(["active", "archive"] as const)(
    "preserves %s ID-less rows with an existing projected message ID",
    async (source) => {
      const f = await fixture();
      const event = {
        type: "message",
        message: {
          role: "assistant",
          content: [f.block],
          __openclaw: { id: f.messageId },
        },
      };
      await seed(f, source === "active" ? [event] : []);
      if (source === "archive") {
        archive(f, [event]);
      }
      const full = await readSessionMessagesWithSourceAsync(f.scope, {
        mode: "full",
        reason: "retained message metadata ID",
        allowResetArchiveFallback: true,
      });
      expect(full.messages).toMatchObject([{ __openclaw: { id: f.messageId } }]);
      expect(await f.download()).not.toBeNull();
    },
  );

  it("falls back to archives only when no live row projects a message", async () => {
    const f = await fixture();
    archive(f);
    await seed(f, [
      { type: "message", id: "null", parentId: null, message: null },
      { type: "message", id: "false", parentId: "null", message: false },
      { type: "message", id: "empty", parentId: "false", message: "" },
    ]);
    expect(await readSessionMessageCountAsync(f.scope)).toBe(3);
    expect(await f.download()).not.toBeNull();
    await seed(f, [message("live", null, [])]);
    expect(await f.download()).toBeNull();
  });

  it.each([
    ["selected", 1_100],
    ["unrelated", 1_100],
    ["unrelated", 999],
  ] as const)("accepts JavaScript-readable %s JSON at depth %i", async (kind, depth) => {
    const f = await fixture();
    const deep = JSON.parse("[".repeat(depth) + "0" + "]".repeat(depth));
    const other = message("other", null, "other");
    const attached = message(f.messageId, "other", [f.block]);
    Object.assign(kind === "selected" ? attached : other, { deep, escapedNul: "valid\u0000text" });
    await seed(f, [other, attached]);
    expect(await f.download()).not.toBeNull();
    expect(
      await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
    ).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
  });

  it("preserves archive duplicates and full-reader oversized recovery", async () => {
    const f = await fixture();
    await seed(f, []);
    // Parentless duplicate records remain in the archive's flat selected history.
    const { parentId: _parent, ...attached } = message(f.messageId, null, [f.block]);
    archive(f, [
      {
        ...attached,
        message: {
          role: "assistant",
          content: [
            f.block,
            {
              type: "image",
              data: Buffer.alloc(300_000, 97).toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
      },
      {
        ...attached,
        message: { role: "assistant", content: "later duplicate without attachment" },
      },
    ]);
    const full = await readSessionMessagesWithSourceAsync(f.scope, {
      mode: "full",
      reason: "archive membership parity",
      allowResetArchiveFallback: true,
    });
    expect(full.messages.length).toBe(2);
    expect(await readSessionMessagesMatchingIdAsync(f.scope, f.messageId)).toEqual(full.messages);
    expect(await f.download()).not.toBeNull();
  });

  it("validates the admitted generation on both matching and missing IDs", async () => {
    const f = await fixture();
    await seed(f, [message(f.messageId, null, [f.block])]);
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...f.scope,
      message: { role: "user", content: "current admission" },
      parentId: f.messageId,
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript anchor");
    }
    const receipt = { ...admitted.anchor, logicalTurnId: "membership-turn", role: "user" as const };
    for (const id of [f.messageId, "missing"]) {
      await runWithSessionTranscriptReadFence(receipt, async () => {
        const full = await readSessionMessagesWithSourceAsync(f.scope, {
          mode: "full",
          reason: "fenced membership parity",
          allowResetArchiveFallback: true,
        });
        expect(await readSessionMessagesMatchingIdAsync(f.scope, id)).toEqual(
          full.messages.filter(
            (row) => (row as { __openclaw: { id: string } })["__openclaw"].id === id,
          ),
        );
      });
      await expect(
        runWithSessionTranscriptReadFence({ ...receipt, generation: "stale" }, () =>
          readSessionMessagesMatchingIdAsync(f.scope, id),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
    }
    expect(openOpenClawAgentDatabase({ agentId: "main" }).db.isTransaction).toBe(false);
  });

  it("keeps validation, presence and selected content on one snapshot across a writer", async () => {
    const f = await fixture();
    const other = message("other", null, "snapshot writer trigger");
    const attached = message(f.messageId, "other", [f.block]);
    await seed(f, [other, attached]);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const row = database.db
      .prepare(
        "SELECT seq, event_json FROM transcript_events WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
      )
      .get(f.scope.sessionId, f.scope.sessionId, f.messageId) as {
      seq: number;
      event_json: string;
    };
    const writer = new DatabaseSync(database.path);
    const parse = JSON.parse;
    let rewrote = false;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (!rewrote && value === JSON.stringify(other)) {
        rewrote = true;
        expect(database.db.isTransaction).toBe(true);
        writer.exec("BEGIN IMMEDIATE");
        try {
          rewriteSqliteTranscriptEventRowsInTransaction({ ...database, db: writer }, f.scope, [
            {
              seq: row.seq,
              expectedEventJson: row.event_json,
              event: message(f.messageId, "other", []),
            },
          ]);
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return parse(value, reviver);
    });
    try {
      expect(await f.download()).not.toBeNull();
      expect(rewrote).toBe(true);
      expect(database.db.isTransaction).toBe(false);
    } finally {
      spy.mockRestore();
      writer.close();
    }
    expect(await f.download()).toBeNull();
  });

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

  it.each([
    { location: "other-session", retainedCount: 2 },
    { location: "before-reset", retainedCount: 1 },
  ] as const)(
    "ignores NUL-corrupt history outside the visible range: $location",
    async ({ location, retainedCount }) => {
      const f = await fixture();
      const corrupt = location === "other-session" ? await fixture("hidden") : f;
      const hidden = message("hidden", null, "hidden history");
      if (location === "other-session") {
        await seed(corrupt, [hidden]);
        await seed(f, [message(f.messageId, null, [f.block])]);
      } else {
        await seed(f, [
          hidden,
          { type: "reset", id: "reset", parentId: "hidden", timestamp, reason: "fresh" },
          message(f.messageId, "reset", [f.block]),
        ]);
      }
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(`UPDATE transcript_events SET event_json = event_json || ? WHERE session_id = ? AND seq = (
          SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = 'hidden'
        )`)
        .run("\u0000trailing", corrupt.scope.sessionId, corrupt.scope.sessionId);
      const full = await readSessionMessagesWithSourceAsync(f.scope, {
        mode: "full",
        reason: "excluded corrupt attachment history",
        allowResetArchiveFallback: true,
      });
      expect(full.messages).toContainEqual(
        expect.objectContaining({
          __openclaw: expect.objectContaining({ id: f.messageId }),
        }),
      );
      expect(await f.download()).not.toBeNull();
      expect(
        await cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
      ).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount });
    },
  );

  it.each([
    ...(["selected", "unrelated", "unrelated-missing"] as const).flatMap((fault) =>
      (["invalid syntax", "literal NUL"] as const).map((corruption) => ({ fault, corruption })),
    ),
    { fault: "unrelated", corruption: "multiple values" },
    { fault: "unrelated", corruption: "premature envelope close" },
  ] as const)(
    "retains records when $fault history JSON has $corruption",
    async ({ fault, corruption }) => {
      const f = await fixture();
      const unrelated = message("unrelated", "first", "unrelated content");
      const attached = message(f.messageId, "unrelated", [f.block]);
      await seed(f, [
        message("first", null, "first visible content"),
        unrelated,
        ...(fault === "unrelated-missing" ? [] : [attached]),
      ]);
      const sourceJson = JSON.stringify(fault === "selected" ? attached : unrelated);
      const invalidJson = {
        "invalid syntax": "{malformed",
        "literal NUL": sourceJson + "\u0000trailing",
        "multiple values": sourceJson + ",{}",
        "premature envelope close": sourceJson + "]\u0000trailing",
      }[corruption];
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db
        .prepare(`UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = (
        SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?
      )`)
        .run(
          invalidJson,
          f.scope.sessionId,
          f.scope.sessionId,
          fault === "selected" ? f.messageId : "unrelated",
        );
      await expect(
        readSessionMessagesWithSourceAsync(f.scope, {
          mode: "full",
          reason: "corrupt managed attachment history",
          allowResetArchiveFallback: true,
        }),
      ).rejects.toBeInstanceOf(SyntaxError);
      await expect(f.download()).rejects.toBeInstanceOf(SyntaxError);
      await expect(
        cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: f.scope.sessionKey }),
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(readManagedImageRecord(f.attachmentId, stateDir)).not.toBeNull();
      expect(fs.existsSync(f.originalPath)).toBe(true);
    },
  );
});
