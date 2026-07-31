// Managed image record store tests cover typed-column authority and atomic mutations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  attachManagedImageRecordToMessage,
  claimManagedImageRecordCleanupIfCurrent,
  deleteClaimedManagedImageRecord,
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
  type ManagedImageRecordDatabase,
} from "./managed-image-record-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function record(overrides: Partial<ManagedImageRecord> = {}): ManagedImageRecord {
  return {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "agent:main:main",
    agentId: "main",
    messageId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    retentionClass: "transient",
    alt: "Cat",
    original: {
      mediaRoot: path.join(os.tmpdir(), "managed-image-media"),
      mediaId: "cat---11111111-1111-4111-8111-111111111111.png",
      mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      contentType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 123,
      filename: "cat.png",
    },
    ...overrides,
  };
}

describe("managed image record SQLite store", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-record-store-");
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("round-trips every typed field", () => {
    const expected = record({
      messageId: "message-1",
      updatedAt: "2026-07-15T00:01:00.000Z",
      retentionClass: "history",
    });

    insertManagedImageRecord(expected, stateDir);

    expect(readManagedImageRecord(expected.attachmentId, stateDir)).toEqual(expected);
  });

  it("uses typed columns when the debug JSON copy is corrupt", () => {
    const expected = record();
    insertManagedImageRecord(expected, stateDir);
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db)
        .updateTable("managed_outgoing_image_records")
        .set({ record_json: '{"attachmentId":"wrong"}' })
        .where("attachment_id", "=", expected.attachmentId),
    );

    expect(readManagedImageRecord(expected.attachmentId, stateDir)).toEqual(expected);
  });

  it("atomically promotes a transient row and refreshes its debug copy", () => {
    const initial = record();
    insertManagedImageRecord(initial, stateDir);

    expect(
      attachManagedImageRecordToMessage({
        attachmentId: initial.attachmentId,
        sessionKey: initial.sessionKey,
        messageId: "message-committed",
        updatedAt: "2026-07-15T00:02:00.000Z",
        stateDir,
      }),
    ).toBe(true);

    const current = readManagedImageRecord(initial.attachmentId, stateDir);
    expect(current).toMatchObject({
      messageId: "message-committed",
      retentionClass: "history",
      updatedAt: "2026-07-15T00:02:00.000Z",
    });
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db)
        .selectFrom("managed_outgoing_image_records")
        .select("record_json")
        .where("attachment_id", "=", initial.attachmentId),
    );
    expect(JSON.parse(row?.record_json ?? "{}")).toEqual(current);
  });

  it("keeps a row changed after cleanup planning", () => {
    const planned = record();
    insertManagedImageRecord(planned, stateDir);
    attachManagedImageRecordToMessage({
      attachmentId: planned.attachmentId,
      sessionKey: planned.sessionKey,
      messageId: "message-committed",
      updatedAt: "2026-07-15T00:02:00.000Z",
      stateDir,
    });

    expect(claimManagedImageRecordCleanupIfCurrent(planned, stateDir)).toBe(false);
    expect(readManagedImageRecord(planned.attachmentId, stateDir)?.messageId).toBe(
      "message-committed",
    );
  });

  it("keeps a cleanup claim durable until the file deletion completes", () => {
    const planned = record();
    insertManagedImageRecord(planned, stateDir);

    expect(claimManagedImageRecordCleanupIfCurrent(planned, stateDir)).toBe(true);
    expect(readManagedImageRecord(planned.attachmentId, stateDir)).toBeNull();
    expect(
      attachManagedImageRecordToMessage({
        attachmentId: planned.attachmentId,
        sessionKey: planned.sessionKey,
        messageId: "too-late",
        updatedAt: "2026-07-15T00:02:00.000Z",
        stateDir,
      }),
    ).toBe(false);
    expect(listManagedImageRecordEntries({ stateDir })).toEqual([
      { record: planned, cleanupPending: true },
    ]);

    expect(deleteClaimedManagedImageRecord(planned, stateDir)).toBe(true);
    expect(listManagedImageRecordEntries({ stateDir })).toEqual([]);
  });
});
