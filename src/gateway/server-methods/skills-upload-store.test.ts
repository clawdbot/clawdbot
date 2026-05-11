import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillUploadStore,
  MAX_ACTIVE_SKILL_UPLOADS,
  SkillUploadRequestError,
} from "./skills-upload-store.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-upload-store-"));
  tempDirs.push(dir);
  return dir;
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
  try {
    await fs.stat(targetPath);
  } catch (err) {
    expect((err as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${targetPath}`);
}

describe("skill upload store", () => {
  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("stores chunks and commits an archive with sha verification", async () => {
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({ rootDir });
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
    const chunk = await store.chunk({
      uploadId: begin.uploadId,
      offset: 3,
      dataBase64: archive.subarray(3).toString("base64"),
    });
    expect(chunk.receivedBytes).toBe(archive.length);

    const commit = await store.commit({ uploadId: begin.uploadId, sha256: digest });
    expect(commit.uploadId).toBe(begin.uploadId);
    expect(commit.receivedBytes).toBe(archive.length);
    expect(commit.sha256).toBe(digest);

    const record = await store.withCommittedUpload(begin.uploadId, async (committedRecord) => {
      return committedRecord;
    });
    expect(record.uploadId).toBe(begin.uploadId);
    expect(record.slug).toBe("demo-skill");
    expect(record.force).toBe(false);
    expect(record.receivedBytes).toBe(archive.length);
    expect(record.actualSha256).toBe(digest);
    expect(record.committed).toBe(true);
    await expectUploadError(
      store.chunk({
        uploadId: begin.uploadId,
        offset: archive.length,
        dataBase64: Buffer.from("x").toString("base64"),
      }),
      "upload is already committed",
    );
  });

  it("rejects traversal slugs and missing uploads", async () => {
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({ rootDir });

    await expectUploadError(
      store.begin({
        kind: "skill-archive",
        slug: "../escape",
        sizeBytes: 1,
      }),
      "Invalid skill slug: ../escape",
    );
    await expectUploadError(
      store.withCommittedUpload(randomUUID(), async (record) => record),
      /^upload not found: /,
    );
  });

  it("rejects offset, size, and sha mismatches", async () => {
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({ rootDir });
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

  it("truncates stale archive tails before retrying a chunk at the recorded offset", async () => {
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({ rootDir });
    const archive = Buffer.from("abcdef");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "retry-skill",
      sizeBytes: archive.length,
    });

    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.subarray(0, 3).toString("base64"),
    });
    const archivePath = path.join(rootDir, begin.uploadId, "archive.zip");
    await fs.appendFile(archivePath, Buffer.from("stale-tail"));
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 3,
      dataBase64: archive.subarray(3).toString("base64"),
    });

    await expect(fs.readFile(archivePath)).resolves.toEqual(archive);
    const commit = await store.commit({ uploadId: begin.uploadId, sha256: sha256(archive) });
    expect(commit.sha256).toBe(sha256(archive));
  });

  it("rejects idempotent commit when committed metadata is missing the actual sha", async () => {
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({ rootDir });
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
    const metadataPath = path.join(rootDir, begin.uploadId, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
    delete metadata.actualSha256;
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await expectUploadError(
      store.commit({ uploadId: begin.uploadId }),
      "committed upload is missing sha256",
    );
  });

  it("limits active uploads", async () => {
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({ rootDir });
    for (let i = 0; i < MAX_ACTIVE_SKILL_UPLOADS; i += 1) {
      await store.begin({
        kind: "skill-archive",
        slug: `active-${i}`,
        sizeBytes: 1,
      });
    }

    await expectUploadError(
      store.begin({
        kind: "skill-archive",
        slug: "too-many",
        sizeBytes: 1,
      }),
      "too many active skill uploads",
    );
  });

  it("expires unfinished and committed uploads", async () => {
    let now = 1000;
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({
      rootDir,
      ttlMs: 10,
      now: () => now,
    });
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
  });

  it("does not sweep committed uploads while an install holds the upload lock", async () => {
    let now = 1000;
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({
      rootDir,
      ttlMs: 10,
      now: () => now,
    });
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
    const sweep = store.begin({
      kind: "skill-archive",
      slug: "sweep-trigger",
      sizeBytes: 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(fs.stat(path.join(rootDir, committed.uploadId))).resolves.toBeTruthy();

    release.resolve();
    await expect(pinned).resolves.toBe(true);
    await sweep;
    await expectMissingPath(path.join(rootDir, committed.uploadId));
  });

  it("does not remove expired idempotent uploads while an install holds the upload lock", async () => {
    let now = 1000;
    const rootDir = await makeTempDir();
    const store = createSkillUploadStore({
      rootDir,
      ttlMs: 10,
      now: () => now,
    });
    const archive = Buffer.from("abc");
    const committed = await store.begin({
      kind: "skill-archive",
      slug: "idempotent-skill",
      sizeBytes: archive.length,
      idempotencyKey: "same-upload",
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
    const repeated = store.begin({
      kind: "skill-archive",
      slug: "idempotent-skill",
      sizeBytes: archive.length,
      idempotencyKey: "same-upload",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(fs.stat(path.join(rootDir, committed.uploadId))).resolves.toBeTruthy();

    release.resolve();
    await expect(pinned).resolves.toBe(true);
    const next = await repeated;
    expect(next.uploadId).not.toBe(committed.uploadId);
    await expectMissingPath(path.join(rootDir, committed.uploadId));
  });
});
