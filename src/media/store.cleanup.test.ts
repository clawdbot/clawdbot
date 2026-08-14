// cleanOldMedia must stay out of the SQLite-managed outgoing tree.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupManagedOutgoingMediaRecords } from "../gateway/managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "../gateway/managed-image-record-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

describe("cleanOldMedia managed-subtree retention", () => {
  let store: typeof import("./store.js");
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    store = await import("./store.js");
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await tempHome.restore();
  });

  it("cannot delete managed history media or lift the legacy migration barrier", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const mediaDir = await store.ensureMediaDir();
    const inbound = await store.saveMediaBuffer(Buffer.from("inbound"), "image/png");
    const historyOriginal = await store.saveMediaBuffer(
      Buffer.from("history original"),
      "image/png",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
    );
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    insertManagedImageRecord(
      {
        attachmentId,
        sessionKey: "agent:main:main",
        messageId: "message-1",
        createdAt: new Date().toISOString(),
        retentionClass: "history",
        alt: "Generated image",
        original: {
          mediaRoot: mediaDir,
          mediaId: historyOriginal.id,
          mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: historyOriginal.size,
          filename: "generated.png",
        },
      },
      stateDir,
    );

    const legacyOrphanPath = path.join(
      mediaDir,
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "legacy-orphan.png",
    );
    const legacyRecordPath = path.join(mediaDir, "outgoing", "records", "legacy.json");
    await fs.mkdir(path.dirname(legacyRecordPath), { recursive: true });
    await fs.writeFile(legacyOrphanPath, "legacy original");
    await fs.writeFile(legacyRecordPath, "{}");
    const past = Date.now() - 60 * 60_000;
    await Promise.all(
      [inbound.path, historyOriginal.path, legacyOrphanPath, legacyRecordPath].map((filePath) =>
        fs.utimes(filePath, past / 1000, past / 1000),
      ),
    );

    await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

    await expect(fs.stat(inbound.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(historyOriginal.path)).resolves.toMatchObject({
      size: historyOriginal.size,
    });
    expect(readManagedImageRecord(attachmentId, stateDir)).not.toBeNull();
    await expect(fs.stat(legacyRecordPath)).resolves.toMatchObject({ size: 2 });

    const cleanup = await cleanupManagedOutgoingMediaRecords({
      stateDir,
      sessionKey: "agent:other:main",
      nowMs: Date.now(),
      transientMaxAgeMs: 1_000,
    });

    expect(cleanup.deletedFileCount).toBe(0);
    await expect(fs.stat(legacyOrphanPath)).resolves.toMatchObject({ size: 15 });
  });
});
