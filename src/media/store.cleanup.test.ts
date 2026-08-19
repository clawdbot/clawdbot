// Media cleanup must respect ownership boundaries between transient staging,
// replayable inbound media, playback cache, and SQLite-managed outgoing media.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupManagedOutgoingMediaRecords } from "../gateway/managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "../gateway/managed-image-record-store.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { markTrustedGeneratedHtmlPath } from "./web-media.js";

type ChannelHistoryMediaTestApi = {
  enforceChannelHistoryMediaLimits(): Promise<void>;
  setChannelHistoryMediaLimitsForTest(limits?: {
    maxBytes: number;
    maxFiles: number;
    ttlMs?: number;
  }): void;
};

function getChannelHistoryMediaTestApi(): ChannelHistoryMediaTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaStoreTestApi")
  ];
  if (!api) {
    throw new Error("media store test API is unavailable");
  }
  return api as ChannelHistoryMediaTestApi;
}

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

  afterEach(() => {
    getChannelHistoryMediaTestApi().setChannelHistoryMediaLimitsForTest();
  });

  it("cannot delete managed history media or lift the legacy migration barrier", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const mediaDir = await store.ensureMediaDir();
    const inbound = await store.saveMediaBuffer(Buffer.from("inbound"), "image/png");
    const channelHistory = await store.saveMediaBuffer(
      Buffer.from("channel history"),
      "application/pdf",
      store.CHANNEL_HISTORY_MEDIA_SUBDIR,
    );
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
      [
        inbound.path,
        channelHistory.path,
        historyOriginal.path,
        legacyOrphanPath,
        legacyRecordPath,
      ].map((filePath) => fs.utimes(filePath, past / 1000, past / 1000)),
    );

    await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

    await expect(fs.stat(inbound.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(channelHistory.path)).resolves.toMatchObject({
      size: channelHistory.size,
    });
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

    const expiredHistory = Date.now() - 24 * 60 * 60_000 - 1_000;
    await fs.utimes(channelHistory.path, expiredHistory / 1000, expiredHistory / 1000);
    await store.pruneChannelHistoryMedia();
    await expect(fs.stat(channelHistory.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires only stale outbound staging and its trusted HTML provenance", async () => {
    const staleInbound = await store.saveMediaBuffer(Buffer.from("inbound"), "image/png");
    const staleOutbound = await store.saveMediaBuffer(
      Buffer.from("<!doctype html><h1>stale</h1>"),
      "text/html",
      "outbound",
      undefined,
      "stale.html",
    );
    const freshOutbound = await store.saveMediaBuffer(
      Buffer.from("fresh outbound"),
      "text/plain",
      "outbound",
    );
    const stalePlayback = await store.saveMediaBuffer(
      Buffer.from("playback"),
      "audio/mpeg",
      store.PLAYBACK_TRANSCODE_SUBDIR,
    );
    const staleManagedOutgoing = await store.saveMediaBuffer(
      Buffer.from("managed outgoing"),
      "image/png",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
    );
    await markTrustedGeneratedHtmlPath(
      staleOutbound.path,
      Buffer.from("<!doctype html><h1>stale</h1>"),
    );
    const stale = Date.now() - 25 * 60 * 60_000;
    await Promise.all(
      [staleInbound.path, staleOutbound.path, stalePlayback.path, staleManagedOutgoing.path].map(
        (filePath) => fs.utimes(filePath, stale / 1000, stale / 1000),
      ),
    );

    await store.pruneOutboundMedia();

    await expect(fs.stat(staleOutbound.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(staleInbound.path)).resolves.toMatchObject({ size: staleInbound.size });
    await expect(fs.stat(freshOutbound.path)).resolves.toMatchObject({ size: freshOutbound.size });
    await expect(fs.stat(stalePlayback.path)).resolves.toMatchObject({ size: stalePlayback.size });
    await expect(fs.stat(staleManagedOutgoing.path)).resolves.toMatchObject({
      size: staleManagedOutgoing.size,
    });

    const { db } = openOpenClawStateDatabase();
    const marker = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "outbound_media_provenance">>(db)
        .selectFrom("outbound_media_provenance")
        .select("realpath")
        .where("realpath", "=", staleOutbound.path),
    );
    expect(marker).toBeUndefined();
  });

  it("enforces channel-history byte and file-count budgets immediately and oldest-first", async () => {
    const testApi = getChannelHistoryMediaTestApi();
    testApi.setChannelHistoryMediaLimitsForTest({ maxBytes: 1024, maxFiles: 2 });
    const first = await store.saveMediaBuffer(
      Buffer.from("first"),
      "text/plain",
      `${store.CHANNEL_HISTORY_MEDIA_SUBDIR}/account-b`,
    );
    const second = await store.saveMediaBuffer(
      Buffer.from("second"),
      "text/plain",
      `${store.CHANNEL_HISTORY_MEDIA_SUBDIR}/account-a`,
    );
    const tiedMtime = Date.now() - 5_000;
    await Promise.all([
      fs.utimes(first.path, tiedMtime / 1000, tiedMtime / 1000),
      fs.utimes(second.path, tiedMtime / 1000, tiedMtime / 1000),
    ]);
    const third = await store.saveMediaBuffer(
      Buffer.from("third"),
      "text/plain",
      store.CHANNEL_HISTORY_MEDIA_SUBDIR,
    );
    const firstRelative = path.relative(
      path.join(store.getMediaDir(), store.CHANNEL_HISTORY_MEDIA_SUBDIR),
      first.path,
    );
    const secondRelative = path.relative(
      path.join(store.getMediaDir(), store.CHANNEL_HISTORY_MEDIA_SUBDIR),
      second.path,
    );
    const evicted = firstRelative.localeCompare(secondRelative) < 0 ? first : second;
    const retained = evicted === first ? second : first;

    await expect(fs.stat(evicted.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(retained.path)).resolves.toMatchObject({ size: retained.size });
    await expect(fs.stat(third.path)).resolves.toMatchObject({ size: third.size });

    testApi.setChannelHistoryMediaLimitsForTest({ maxBytes: 8, maxFiles: 10 });
    const fourth = await store.saveMediaBuffer(
      Buffer.from("four"),
      "text/plain",
      store.CHANNEL_HISTORY_MEDIA_SUBDIR,
    );
    await expect(fs.stat(third.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(retained.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(fourth.path)).resolves.toMatchObject({ size: 4 });
  });

  it("covers source and stream publication without touching sibling media trees", async () => {
    const testApi = getChannelHistoryMediaTestApi();
    testApi.setChannelHistoryMediaLimitsForTest({ maxBytes: 1024, maxFiles: 1 });
    const mediaDir = await store.ensureMediaDir();
    const sourcePath = path.join(mediaDir, "source.txt");
    await fs.writeFile(sourcePath, "source");
    const source = await store.saveMediaSource(
      sourcePath,
      undefined,
      `${store.CHANNEL_HISTORY_MEDIA_SUBDIR}/source-account`,
    );
    const inbound = await store.saveMediaBuffer(Buffer.from("inbound"), "text/plain", "inbound");
    const stream = await store.saveMediaStream(
      (async function* () {
        yield Buffer.from("stream");
      })(),
      "text/plain",
      `${store.CHANNEL_HISTORY_MEDIA_SUBDIR}/stream-account`,
    );

    await expect(fs.stat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stream.path)).resolves.toMatchObject({ size: 6 });
    await expect(fs.stat(inbound.path)).resolves.toMatchObject({ size: inbound.size });
  });

  it("fails a publication that cannot fit while leaving no dangling media claim", async () => {
    const testApi = getChannelHistoryMediaTestApi();
    testApi.setChannelHistoryMediaLimitsForTest({ maxBytes: 3, maxFiles: 1 });
    await expect(
      store.saveMediaBuffer(
        Buffer.from("oversized"),
        "text/plain",
        store.CHANNEL_HISTORY_MEDIA_SUBDIR,
      ),
    ).rejects.toThrow("channel-history media publication exceeded its fixed storage budget");

    const historyDir = path.join(store.getMediaDir(), store.CHANNEL_HISTORY_MEDIA_SUBDIR);
    const remaining = await fs.readdir(historyDir, { recursive: true }).catch(() => []);
    const remainingFiles = (
      await Promise.all(
        remaining.map(async (name) => {
          const relativePath = name;
          const stat = await fs.lstat(path.join(historyDir, relativePath)).catch(() => null);
          return stat?.isFile() && !path.basename(relativePath).startsWith(".")
            ? relativePath
            : null;
        }),
      )
    ).filter((name): name is string => name !== null);
    expect(remainingFiles).toEqual([]);
  });
});
