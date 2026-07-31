// Upload store tests cover SQLite staging, integrity, concurrency, and cleanup.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { SkillUploadRequestError } from "./upload-store.js";
import {
  deleteExpiredSkillUploadUnlessLeased,
  renewSkillUploadInstallLease,
} from "./upload-store.sqlite.js";
import { createSkillUploadStore } from "./upload-store.test-support.js";

type ReadSkillUploadArchiveChunks =
  typeof import("./upload-store.sqlite.js").readSkillUploadArchiveChunks;

const uploadSqliteMocks = vi.hoisted(() => ({
  defaultReadSkillUploadArchiveChunks: undefined as ReadSkillUploadArchiveChunks | undefined,
  readSkillUploadArchiveChunks: vi.fn<ReadSkillUploadArchiveChunks>(),
}));

vi.mock("./upload-store.sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-store.sqlite.js")>();
  uploadSqliteMocks.defaultReadSkillUploadArchiveChunks = actual.readSkillUploadArchiveChunks;
  uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementation(
    actual.readSkillUploadArchiveChunks,
  );
  return {
    ...actual,
    readSkillUploadArchiveChunks: uploadSqliteMocks.readSkillUploadArchiveChunks,
  };
});

const ACTIVE_UPLOAD_LIMIT = 32;

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-upload-store-"));
  tempDirs.push(dir);
  return dir;
}

async function makeStore(options?: {
  installLeaseHeartbeatMs?: number;
  installLeaseMs?: number;
  now?: () => number;
  ttlMs?: number;
}) {
  const root = await makeTempDir();
  const databasePath = path.join(root, "openclaw.sqlite");
  return {
    root,
    databasePath,
    store: createSkillUploadStore({
      path: databasePath,
      tempRootDir: root,
      ...options,
    }),
  };
}

function stateDatabase(databasePath: string) {
  return openOpenClawStateDatabase({ path: databasePath }).db;
}

function uploadCount(databasePath: string): number {
  return (
    stateDatabase(databasePath).prepare("SELECT count(*) AS count FROM skill_uploads").get() as {
      count: number;
    }
  ).count;
}

function uploadExists(databasePath: string, uploadId: string): boolean {
  return Boolean(
    stateDatabase(databasePath)
      .prepare("SELECT 1 AS found FROM skill_uploads WHERE upload_id = ?")
      .get(uploadId),
  );
}

function chunkCount(databasePath: string, uploadId?: string): number {
  const row = uploadId
    ? stateDatabase(databasePath)
        .prepare("SELECT count(*) AS count FROM skill_upload_chunks WHERE upload_id = ?")
        .get(uploadId)
    : stateDatabase(databasePath)
        .prepare("SELECT count(*) AS count FROM skill_upload_chunks")
        .get();
  return (row as { count: number }).count;
}

function installLeaseCount(databasePath: string, uploadId: string): number {
  return (
    stateDatabase(databasePath)
      .prepare(
        "SELECT count(*) AS count FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
      )
      .get(uploadId) as { count: number }
  ).count;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function expectUploadError(
  promise: Promise<unknown>,
  message: string | RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SkillUploadRequestError);
    const actual = err instanceof Error ? err.message : String(err);
    if (typeof message === "string") {
      expect(actual).toBe(message);
    } else {
      expect(actual).toMatch(message);
    }
    return;
  }
  throw new Error("expected upload request error");
}

async function expectMissingPath(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("skill upload store", () => {
  let activeUploadLimitError: unknown;
  let activeLimitRoot: string | undefined;

  beforeAll(async () => {
    activeLimitRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-upload-limit-"));
    const store = createSkillUploadStore({
      path: path.join(activeLimitRoot, "openclaw.sqlite"),
      tempRootDir: activeLimitRoot,
    });
    for (let i = 0; i < ACTIVE_UPLOAD_LIMIT; i += 1) {
      await store.begin({ kind: "skill-archive", slug: `active-${i}`, sizeBytes: 1 });
    }
    try {
      await store.begin({ kind: "skill-archive", slug: "too-many", sizeBytes: 1 });
    } catch (err) {
      activeUploadLimitError = err;
    }
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    if (activeLimitRoot) {
      await fs.rm(activeLimitRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    uploadSqliteMocks.readSkillUploadArchiveChunks.mockReset();
    uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementation(
      uploadSqliteMocks.defaultReadSkillUploadArchiveChunks!,
    );
    closeOpenClawStateDatabaseForTest();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("stores chunks, commits one archive blob, and materializes only for the action", async () => {
    const { root, databasePath, store } = await makeStore();
    const archive = Buffer.from("zip-bytes");
    const digest = sha256(archive);
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "demo-skill",
      sizeBytes: archive.length,
      sha256: digest,
      idempotencyKey: "same-upload",
    });
    const repeated = await store.begin({
      kind: "skill-archive",
      slug: "demo-skill",
      sizeBytes: archive.length,
      sha256: digest,
      idempotencyKey: "same-upload",
    });
    expect(repeated.uploadId).toBe(begin.uploadId);

    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.subarray(0, 3).toString("base64"),
    });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(1);
    const chunk = await store.chunk({
      uploadId: begin.uploadId,
      offset: 3,
      dataBase64: archive.subarray(3).toString("base64"),
    });
    expect(chunk.receivedBytes).toBe(archive.length);

    const commit = await store.commit({ uploadId: begin.uploadId, sha256: digest });
    expect(commit).toMatchObject({
      uploadId: begin.uploadId,
      receivedBytes: archive.length,
      sha256: digest,
    });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
    const persisted = stateDatabase(databasePath)
      .prepare(
        "SELECT archive_blob, committed, actual_sha256 FROM skill_uploads WHERE upload_id = ?",
      )
      .get(begin.uploadId) as {
      archive_blob: Uint8Array;
      committed: number;
      actual_sha256: string;
    };
    expect(Buffer.from(persisted.archive_blob)).toEqual(archive);
    expect(persisted).toMatchObject({ committed: 1, actual_sha256: digest });

    let materializedPath = "";
    const record = await store.withCommittedUpload(begin.uploadId, async (committedRecord) => {
      materializedPath = committedRecord.archivePath;
      expect(await fs.readFile(materializedPath)).toEqual(archive);
      if (process.platform !== "win32") {
        expect((await fs.stat(materializedPath)).mode & 0o777).toBe(0o600);
      }
      return committedRecord;
    });
    expect(record).toMatchObject({
      uploadId: begin.uploadId,
      slug: "demo-skill",
      force: false,
      receivedBytes: archive.length,
      actualSha256: digest,
      committed: true,
    });
    await expectMissingPath(materializedPath);
    await expectMissingPath(path.join(root, "tmp", "skill-uploads"));
  });

  it("rejects traversal slugs and missing uploads", async () => {
    const { store } = await makeStore();
    await expectUploadError(
      store.begin({ kind: "skill-archive", slug: "../escape", sizeBytes: 1 }),
      "Invalid skill slug: ../escape",
    );
    await expectUploadError(
      store.withCommittedUpload(randomUUID(), async (record) => record),
      /^upload not found: /,
    );
  });

  it("rejects offset, size, and sha mismatches", async () => {
    const { store } = await makeStore();
    const archive = Buffer.from("abc");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "demo-skill",
      sizeBytes: archive.length,
    });
    await expectUploadError(
      store.chunk({
        uploadId: begin.uploadId,
        offset: 1,
        dataBase64: archive.subarray(0, 1).toString("base64"),
      }),
      "upload offset mismatch: expected 0, got 1",
    );
    await expectUploadError(
      store.chunk({
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: Buffer.from("abcd").toString("base64"),
      }),
      "upload chunk exceeds declared size",
    );
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.subarray(0, 2).toString("base64"),
    });
    await expectUploadError(
      store.commit({ uploadId: begin.uploadId }),
      "upload size mismatch: expected 3, got 2",
    );

    const second = await store.begin({
      kind: "skill-archive",
      slug: "second-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: second.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await expectUploadError(
      store.commit({ uploadId: second.uploadId, sha256: "0".repeat(64) }),
      "upload sha256 mismatch",
    );
  });

  it("resumes a multi-chunk upload from a new store instance", async () => {
    const { databasePath, root, store } = await makeStore();
    const archive = Buffer.from("abcdef");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "resume-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.subarray(0, 3).toString("base64"),
    });

    const reopened = createSkillUploadStore({ path: databasePath, tempRootDir: root });
    await reopened.chunk({
      uploadId: begin.uploadId,
      offset: 3,
      dataBase64: archive.subarray(3).toString("base64"),
    });
    await expect(
      reopened.commit({ uploadId: begin.uploadId, sha256: sha256(archive) }),
    ).resolves.toMatchObject({ sha256: sha256(archive) });
  });

  it("keeps large chunks separate until one final archive write", async () => {
    const { databasePath, store } = await makeStore();
    const firstChunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const secondChunk = Buffer.alloc(4 * 1024 * 1024, 0x62);
    const archive = Buffer.concat([firstChunk, secondChunk]);
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "large-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: firstChunk.toString("base64"),
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: firstChunk.length,
      dataBase64: secondChunk.toString("base64"),
    });
    const staged = stateDatabase(databasePath)
      .prepare("SELECT length(archive_blob) AS bytes FROM skill_uploads WHERE upload_id = ?")
      .get(begin.uploadId) as { bytes: number };
    expect(staged.bytes).toBe(0);
    expect(chunkCount(databasePath, begin.uploadId)).toBe(2);

    await store.commit({ uploadId: begin.uploadId, sha256: sha256(archive) });
    const committed = stateDatabase(databasePath)
      .prepare("SELECT length(archive_blob) AS bytes FROM skill_uploads WHERE upload_id = ?")
      .get(begin.uploadId) as { bytes: number };
    expect(committed.bytes).toBe(archive.length);
    expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
  });

  it("uses the expiry and idempotency indexes", async () => {
    const { databasePath } = await makeStore();
    const db = stateDatabase(databasePath);
    const expiryPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT upload_id FROM skill_uploads WHERE expires_at <= ?")
      .all(Date.now()) as Array<{ detail: string }>;
    const idempotencyPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT upload_id FROM skill_uploads WHERE idempotency_key_hash = ?",
      )
      .all("hash") as Array<{ detail: string }>;
    expect(expiryPlan.map((row) => row.detail).join("\n")).toContain("idx_skill_uploads_expiry");
    expect(idempotencyPlan.map((row) => row.detail).join("\n")).toMatch(
      /idx_skill_uploads_idempotency|sqlite_autoindex_skill_uploads/u,
    );
  });

  it("accepts exactly one concurrent chunk at the same offset", async () => {
    const { databasePath, root, store } = await makeStore();
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "concurrent-skill",
      sizeBytes: 2,
    });
    const secondStore = createSkillUploadStore({ path: databasePath, tempRootDir: root });
    const results = await Promise.allSettled([
      store.chunk({
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: Buffer.from("a").toString("base64"),
      }),
      secondStore.chunk({
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: Buffer.from("b").toString("base64"),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "upload offset mismatch: expected 1, got 0" }),
    });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(1);
  });

  it("creates one row for concurrent idempotent begins and rejects conflicts", async () => {
    const { databasePath, root, store } = await makeStore();
    const secondStore = createSkillUploadStore({ path: databasePath, tempRootDir: root });
    const params = {
      kind: "skill-archive" as const,
      slug: "idem-skill",
      sizeBytes: 3,
      idempotencyKey: "same-key",
    };
    const [first, second] = await Promise.all([store.begin(params), secondStore.begin(params)]);
    expect(second.uploadId).toBe(first.uploadId);
    expect(uploadCount(databasePath)).toBe(1);
    await expectUploadError(
      store.begin({ ...params, slug: "different-skill" }),
      "idempotencyKey conflicts with a different upload",
    );
  });

  it("keeps the optional begin sha immutable across commit retries", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const digest = sha256(archive);
    const params = {
      kind: "skill-archive" as const,
      slug: "late-sha-skill",
      sizeBytes: archive.length,
      idempotencyKey: "late-sha-key",
    };
    const begin = await store.begin(params);
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: begin.uploadId, sha256: digest });

    await expect(store.begin(params)).resolves.toMatchObject({
      uploadId: begin.uploadId,
      receivedBytes: archive.length,
    });
    expect(
      stateDatabase(databasePath)
        .prepare("SELECT sha256, actual_sha256 FROM skill_uploads WHERE upload_id = ?")
        .get(begin.uploadId),
    ).toMatchObject({ sha256: null, actual_sha256: digest });
  });

  it("rejects idempotent commit when committed metadata is missing the actual sha", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "corrupt-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: begin.uploadId });
    stateDatabase(databasePath)
      .prepare("UPDATE skill_uploads SET actual_sha256 = NULL WHERE upload_id = ?")
      .run(begin.uploadId);
    await expectUploadError(
      store.commit({ uploadId: begin.uploadId }),
      "committed upload is missing sha256",
    );
  });

  it("returns the committed result when another process deletes chunks first", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("concurrent-commit");
    const digest = sha256(archive);
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "concurrent-commit-skill",
      sizeBytes: archive.length,
      sha256: digest,
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementationOnce((uploadId, options) => {
      const db = stateDatabase(databasePath);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE skill_uploads SET archive_blob = ?, actual_sha256 = ?, committed = 1, committed_at = ? WHERE upload_id = ?",
        ).run(archive, digest, Date.now(), uploadId);
        db.prepare("DELETE FROM skill_upload_chunks WHERE upload_id = ?").run(uploadId);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return uploadSqliteMocks.defaultReadSkillUploadArchiveChunks!(uploadId, options);
    });

    await expect(store.commit({ uploadId: begin.uploadId, sha256: digest })).resolves.toMatchObject(
      {
        uploadId: begin.uploadId,
        receivedBytes: archive.length,
        sha256: digest,
      },
    );
    expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
  });

  it("limits active uploads", async () => {
    await expectUploadError(
      Promise.reject(toLintErrorObject(activeUploadLimitError, "Non-Error rejection")),
      "too many active skill uploads",
    );
  });

  it("rejects new uploads when the clock cannot produce a valid expiry", async () => {
    const invalid = await makeStore({ now: () => Number.NaN });
    await expectUploadError(
      invalid.store.begin({ kind: "skill-archive", slug: "invalid-clock", sizeBytes: 1 }),
      "invalid upload expiry",
    );
    const overflow = await makeStore({ now: () => MAX_DATE_TIMESTAMP_MS });
    await expectUploadError(
      overflow.store.begin({ kind: "skill-archive", slug: "overflow-clock", sizeBytes: 1 }),
      "invalid upload expiry",
    );
  });

  it("expires unfinished and committed uploads", async () => {
    let now = 1000;
    const { databasePath, store } = await makeStore({ ttlMs: 10, now: () => now });
    const archive = Buffer.from("abc");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "demo-skill",
      sizeBytes: archive.length,
    });
    now = 1011;
    await expectUploadError(
      store.chunk({
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: archive.toString("base64"),
      }),
      "upload has expired",
    );
    expect(uploadCount(databasePath)).toBe(0);

    now = 2000;
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "committed-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });
    now = 2011;
    await expectUploadError(
      store.withCommittedUpload(committed.uploadId, async (record) => record),
      "upload has expired",
    );
    expect(uploadCount(databasePath)).toBe(0);
  });

  it("does not sweep an upload while an install holds its lease", async () => {
    let now = 1000;
    const { databasePath, store } = await makeStore({ ttlMs: 10, now: () => now });
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "pinned-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });

    const entered = deferred();
    const release = deferred();
    const pinned = store.withCommittedUpload(committed.uploadId, async () => {
      entered.resolve();
      await release.promise;
      return true;
    });
    await entered.promise;
    now = 1011;
    const sweep = store.begin({ kind: "skill-archive", slug: "sweep-trigger", sizeBytes: 1 });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(uploadCount(databasePath)).toBe(1);

    now = 5000;
    release.resolve();
    await expect(pinned).resolves.toBe(true);
    await expect(sweep).resolves.toMatchObject({ expiresAt: 5010 });
    expect(uploadCount(databasePath)).toBe(1);
  });

  it("rechecks chunk expiry after cleanup waits on another install", async () => {
    let now = 1000;
    const { databasePath, store } = await makeStore({ ttlMs: 10, now: () => now });
    const archive = Buffer.from("abc");
    const pinnedUpload = await store.begin({
      kind: "skill-archive",
      slug: "blocking-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: pinnedUpload.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: pinnedUpload.uploadId });
    now = 1005;
    const pending = await store.begin({
      kind: "skill-archive",
      slug: "waiting-skill",
      sizeBytes: archive.length,
    });

    const entered = deferred();
    const release = deferred();
    const pinned = store.withCommittedUpload(pinnedUpload.uploadId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    now = 1011;
    const chunk = store.chunk({
      uploadId: pending.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    now = 1020;
    release.resolve();
    await pinned;
    await expectUploadError(chunk, "upload has expired");
    expect(uploadExists(databasePath, pending.uploadId)).toBe(false);
  });

  it("renews the install lease and preserves an expired leased upload", async () => {
    const { databasePath, store } = await makeStore({
      installLeaseHeartbeatMs: 10,
      installLeaseMs: 100,
    });
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "heartbeat-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });

    const entered = deferred();
    const release = deferred();
    const pinned = store.withCommittedUpload(committed.uploadId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const db = stateDatabase(databasePath);
    const initialHeartbeat = (
      db
        .prepare(
          "SELECT heartbeat_at FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId) as { heartbeat_at: number }
    ).heartbeat_at;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
    const renewedHeartbeat = (
      db
        .prepare(
          "SELECT heartbeat_at FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId) as { heartbeat_at: number }
    ).heartbeat_at;
    expect(renewedHeartbeat).toBeGreaterThan(initialHeartbeat);

    db.prepare("UPDATE skill_uploads SET expires_at = ? WHERE upload_id = ?").run(
      Date.now() - 1,
      committed.uploadId,
    );
    expect(
      deleteExpiredSkillUploadUnlessLeased({
        uploadId: committed.uploadId,
        nowMs: Date.now(),
        options: { path: databasePath },
      }),
    ).toBe("leased");
    expect(uploadCount(databasePath)).toBe(1);
    expect(installLeaseCount(databasePath, committed.uploadId)).toBe(1);

    release.resolve();
    await pinned;
    expect(installLeaseCount(databasePath, committed.uploadId)).toBe(0);
  });

  it("starts install lease expiry from the claim time", async () => {
    let now = 1000;
    const { databasePath, store } = await makeStore({
      installLeaseHeartbeatMs: 1000,
      installLeaseMs: 100,
      now: () => now,
      ttlMs: 10_000,
    });
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "bounded-lease-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });

    const entered = deferred();
    const release = deferred();
    const pinned = store.withCommittedUpload(committed.uploadId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(
      stateDatabase(databasePath)
        .prepare(
          "SELECT expires_at FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId),
    ).toMatchObject({ expires_at: 1100 });

    now = 1001;
    release.resolve();
    await pinned;
  });

  it("does not renew an expired install lease", async () => {
    const { databasePath, store } = await makeStore({ installLeaseHeartbeatMs: 60_000 });
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "expired-heartbeat-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });

    await store.withCommittedUpload(committed.uploadId, async () => {
      const db = stateDatabase(databasePath);
      const lease = db
        .prepare(
          "SELECT owner FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId) as { owner: string };
      const heartbeatAt = Date.now();
      db.prepare(
        "UPDATE state_leases SET expires_at = ? WHERE scope = 'skill-upload-install' AND lease_key = ?",
      ).run(heartbeatAt - 1, committed.uploadId);
      expect(
        renewSkillUploadInstallLease({
          uploadId: committed.uploadId,
          owner: lease.owner,
          heartbeatAt,
          expiresAt: heartbeatAt + 60_000,
          options: { path: databasePath },
        }),
      ).toBe(false);
    });
  });

  it("lets the install lease owner remove the upload", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "consumed-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });
    let archivePath = "";
    await store.withCommittedUpload(committed.uploadId, async (record, controls) => {
      archivePath = record.archivePath;
      await controls.remove();
    });
    await expectMissingPath(archivePath);
    expect(uploadCount(databasePath)).toBe(0);
    expect(installLeaseCount(databasePath, committed.uploadId)).toBe(0);
  });

  it("does not remove an upload after the callback loses lease ownership", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "replacement-owner-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });

    await store.withCommittedUpload(committed.uploadId, async (_record, controls) => {
      const replacementAt = Date.now();
      stateDatabase(databasePath)
        .prepare(
          "UPDATE state_leases SET owner = ?, expires_at = ?, updated_at = ? WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .run("replacement-owner", replacementAt + 60_000, replacementAt, committed.uploadId);
      await expectUploadError(controls.remove(), "upload install lease is no longer active");
    });

    expect(uploadCount(databasePath)).toBe(1);
    expect(
      stateDatabase(databasePath)
        .prepare(
          "SELECT owner FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId),
    ).toMatchObject({ owner: "replacement-owner" });
  });

  it("does not remove an upload after its install lease expires", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "expired-owner-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });

    await store.withCommittedUpload(committed.uploadId, async (_record, controls) => {
      stateDatabase(databasePath)
        .prepare(
          "UPDATE state_leases SET expires_at = ? WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .run(Date.now() - 1, committed.uploadId);
      await expectUploadError(controls.remove(), "upload install lease is no longer active");
    });

    expect(uploadCount(databasePath)).toBe(1);
  });

  it("cleans temporary materialization and preserves the upload on action failure", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");

    const committed = await store.begin({
      kind: "skill-archive",
      slug: "throwing-skill",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: committed.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: committed.uploadId });
    let archivePath = "";
    await expect(
      store.withCommittedUpload(committed.uploadId, async (record) => {
        archivePath = record.archivePath;
        throw new Error("action failed");
      }),
    ).rejects.toThrow("action failed");
    await expectMissingPath(archivePath);
    expect(uploadCount(databasePath)).toBe(1);
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
