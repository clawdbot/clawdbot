// Doctor migration tests cover strict managed-image import and source retirement.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
} from "../gateway/managed-image-record-store.js";
import type { ManagedImageRecordDatabase } from "../gateway/managed-image-record-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyManagedOutgoingImages,
  migrateLegacyManagedOutgoingImages,
} from "./state-migrations.managed-outgoing-images.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type LegacyRecord = Omit<ManagedImageRecord, "original"> & {
  original: Omit<ManagedImageRecord["original"], "mediaId" | "mediaRoot" | "mediaSubdir"> & {
    path: string;
  };
};

function resolveLegacyManagedOutgoingImageRecordsDir(stateDir: string): string {
  return path.join(stateDir, "media", "outgoing", "records");
}

function attachmentId(index: number): string {
  return `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

async function writeLegacyRecord(params: {
  stateDir: string;
  index?: number;
  overrides?: Partial<LegacyRecord>;
}): Promise<{ sourcePath: string; originalPath: string; record: LegacyRecord }> {
  const id = attachmentId(params.index ?? 1);
  const recordsDir = resolveLegacyManagedOutgoingImageRecordsDir(params.stateDir);
  const originalsDir = path.join(params.stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR);
  await fsp.mkdir(recordsDir, { recursive: true });
  await fsp.mkdir(originalsDir, { recursive: true });
  const originalPath = path.join(originalsDir, `${id}.png`);
  await fsp.writeFile(originalPath, "image-bytes");
  const record: LegacyRecord = {
    attachmentId: id,
    sessionKey: "agent:main:main",
    agentId: "main",
    messageId: "message-1",
    createdAt: "2026-07-15T00:00:00.000Z",
    retentionClass: "history",
    alt: "Cat",
    original: {
      path: originalPath,
      contentType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 11,
      filename: "cat.png",
    },
    ...params.overrides,
  };
  const sourcePath = path.join(recordsDir, `${id}.json`);
  await fsp.writeFile(sourcePath, JSON.stringify(record, null, 2));
  return { sourcePath, originalPath, record };
}

function migrate(stateDir: string, overrides: Record<string, unknown> = {}) {
  return migrateLegacyManagedOutgoingImages({
    detected: detectLegacyManagedOutgoingImages({
      stateDir,
      doctorOnlyStateMigrations: true,
    }),
    stateDir,
    ...overrides,
  });
}

describe("legacy managed outgoing image migration", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-migration-");
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("imports typed metadata, verifies it, and removes JSON", async () => {
    const legacy = await writeLegacyRecord({ stateDir });

    const result = migrate(stateDir);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 managed outgoing image record(s) → shared SQLite state",
    );
    await expect(fsp.access(legacy.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(legacy.originalPath)).resolves.toBeUndefined();
    expect(readManagedImageRecord(legacy.record.attachmentId, stateDir)).toEqual({
      ...legacy.record,
      original: {
        ...legacy.record.original,
        mediaRoot: path.join(stateDir, "media"),
        mediaId: path.basename(legacy.originalPath),
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        path: undefined,
      },
    });
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db)
        .selectFrom("managed_outgoing_image_records")
        .select("record_json")
        .where("attachment_id", "=", legacy.record.attachmentId),
    );
    expect(row?.record_json).not.toContain(legacy.originalPath);
    expect(row?.record_json).not.toContain('"path"');
  });

  it("recovers an interrupted Doctor source claim", async () => {
    const legacy = await writeLegacyRecord({ stateDir });
    const claimPath = `${legacy.sourcePath}.doctor-importing-4242-22222222-2222-4222-8222-222222222222`;
    await fsp.rename(legacy.sourcePath, claimPath);

    const detected = detectLegacyManagedOutgoingImages({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    const result = migrateLegacyManagedOutgoingImages({ detected, stateDir });

    expect(detected.hasLegacy).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(readManagedImageRecord(legacy.record.attachmentId, stateDir)).not.toBeNull();
    await expect(fsp.access(legacy.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards expired transient metadata and its attachment file", async () => {
    const legacy = await writeLegacyRecord({
      stateDir,
      overrides: {
        messageId: null,
        retentionClass: "transient",
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    });

    const result = migrate(stateDir, { nowMs: Date.parse("2026-07-15T00:16:00.000Z") });

    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("Discarded 1 expired managed outgoing image");
    expect(readManagedImageRecord(legacy.record.attachmentId, stateDir)).toBeNull();
    await expect(fsp.access(legacy.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(legacy.originalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains expired metadata when its attachment cannot be deleted", async () => {
    const legacy = await writeLegacyRecord({
      stateDir,
      overrides: {
        messageId: null,
        retentionClass: "transient",
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    });
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("synthetic attachment remove failure");
    });

    let result!: ReturnType<typeof migrate>;
    try {
      result = migrate(stateDir, { nowMs: Date.parse("2026-07-15T00:16:00.000Z") });
    } finally {
      rmSpy.mockRestore();
    }

    expect(result.warnings.join("\n")).toContain("synthetic attachment remove failure");
    await expect(fsp.access(legacy.sourcePath)).resolves.toBeUndefined();
    await expect(fsp.access(legacy.originalPath)).resolves.toBeUndefined();
    expect(readManagedImageRecord(legacy.record.attachmentId, stateDir)).toBeNull();
  });

  it("fails atomically on a conflicting SQLite row and retains every source", async () => {
    const first = await writeLegacyRecord({ stateDir, index: 1 });
    const second = await writeLegacyRecord({ stateDir, index: 2 });
    insertManagedImageRecord(
      {
        attachmentId: second.record.attachmentId,
        sessionKey: "agent:other:main",
        messageId: "different-message",
        createdAt: second.record.createdAt,
        retentionClass: "history",
        alt: "Different",
        original: {
          mediaRoot: path.join(stateDir, "media"),
          mediaId: path.basename(second.originalPath),
          mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: 1,
          filename: "different.png",
        },
      },
      stateDir,
    );

    const result = migrate(stateDir);

    expect(result.warnings.join("\n")).toContain("conflicts with shared SQLite state");
    expect(readManagedImageRecord(first.record.attachmentId, stateDir)).toBeNull();
    await expect(fsp.access(first.sourcePath)).resolves.toBeUndefined();
    await expect(fsp.access(second.sourcePath)).resolves.toBeUndefined();
  });

  it("retains malformed and symlinked sources", async () => {
    const recordsDir = resolveLegacyManagedOutgoingImageRecordsDir(stateDir);
    await fsp.mkdir(recordsDir, { recursive: true });
    const malformedPath = path.join(recordsDir, `${attachmentId(1)}.json`);
    await fsp.writeFile(malformedPath, "{not json");

    const malformed = migrate(stateDir);
    expect(malformed.warnings.join("\n")).toContain("Failed reading legacy managed outgoing");
    await expect(fsp.access(malformedPath)).resolves.toBeUndefined();

    await fsp.rm(malformedPath);
    const targetPath = path.join(stateDir, "target.json");
    await fsp.writeFile(targetPath, "{}");
    await fsp.symlink(targetPath, malformedPath);
    const symlinked = migrate(stateDir);
    expect(symlinked.warnings.join("\n")).toContain("non-symlink file");
    expect(fs.lstatSync(malformedPath).isSymbolicLink()).toBe(true);
  });

  it("keeps JSON when the source changes before cleanup", async () => {
    const legacy = await writeLegacyRecord({ stateDir });

    const result = migrate(stateDir, {
      beforeClaim: () => {
        fs.appendFileSync(legacy.sourcePath, "\n");
      },
    });

    expect(result.warnings.join("\n")).toContain("Failed claiming legacy managed outgoing");
    await expect(fsp.access(legacy.sourcePath)).resolves.toBeUndefined();
    expect(readManagedImageRecord(legacy.record.attachmentId, stateDir)).toBeNull();
  });

  it("restores JSON when cleanup fails and succeeds on retry", async () => {
    const legacy = await writeLegacyRecord({ stateDir });

    const failed = migrate(stateDir, {
      removeSource: () => {
        throw new Error("synthetic remove failure");
      },
    });
    expect(failed.warnings.join("\n")).toContain("synthetic remove failure");
    await expect(fsp.access(legacy.sourcePath)).resolves.toBeUndefined();

    const retried = migrate(stateDir);
    expect(retried.warnings).toEqual([]);
    await expect(fsp.access(legacy.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
