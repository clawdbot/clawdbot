import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { validateRequestedSkillSlug } from "../../agents/skills-archive-install.js";
import { resolveStateDir } from "../../config/paths.js";
import { DEFAULT_MAX_ARCHIVE_BYTES_ZIP } from "../../infra/archive.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createAsyncLock, readDurableJsonFile, writeJsonAtomic } from "../../infra/json-files.js";

export const SKILL_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const MAX_SKILL_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_SKILL_UPLOAD_CHUNK_BYTES / 3) * 4;
export const MAX_ACTIVE_SKILL_UPLOADS = 32;
export const SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH = 2048;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const locks = new Map<string, { lock: ReturnType<typeof createAsyncLock>; references: number }>();

export class SkillUploadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillUploadRequestError";
  }
}

export type SkillUploadRecord = {
  version: 1;
  kind: "skill-archive";
  uploadId: string;
  slug: string;
  force: boolean;
  sizeBytes: number;
  sha256?: string;
  actualSha256?: string;
  receivedBytes: number;
  archivePath: string;
  createdAt: number;
  expiresAt: number;
  committed: boolean;
  committedAt?: number;
  idempotencyKeyHash?: string;
};

export type SkillUploadStore = ReturnType<typeof createSkillUploadStore>;

type BeginParams = {
  kind: "skill-archive";
  slug: string;
  sizeBytes: number;
  sha256?: string;
  force?: boolean;
  idempotencyKey?: string;
};

type ChunkParams = {
  uploadId: string;
  offset: number;
  dataBase64: string;
};

type CommitParams = {
  uploadId: string;
  sha256?: string;
};

type IdempotencyRecord = {
  version: 1;
  keyHash: string;
  uploadId: string;
  kind: "skill-archive";
  slug: string;
  force: boolean;
  sizeBytes: number;
  sha256?: string;
};

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let entry = locks.get(key);
  if (!entry) {
    entry = { lock: createAsyncLock(), references: 0 };
    locks.set(key, entry);
  }
  entry.references += 1;
  try {
    return await entry.lock(fn);
  } finally {
    entry.references -= 1;
    if (entry.references === 0) {
      locks.delete(key);
    }
  }
}

export function normalizeSkillUploadSha256(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new SkillUploadRequestError("invalid sha256");
  }
  return normalized;
}

function validateUploadId(uploadId: string): string {
  const normalized = uploadId.trim();
  if (!UPLOAD_ID_PATTERN.test(normalized)) {
    throw new SkillUploadRequestError("invalid uploadId");
  }
  return normalized;
}

function isUploadId(value: string): boolean {
  return UPLOAD_ID_PATTERN.test(value);
}

function validateSizeBytes(sizeBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new SkillUploadRequestError("invalid sizeBytes");
  }
  if (sizeBytes > DEFAULT_MAX_ARCHIVE_BYTES_ZIP) {
    throw new SkillUploadRequestError("skill archive exceeds maximum upload size");
  }
  return sizeBytes;
}

function validateUploadSlug(slug: string): string {
  try {
    return validateRequestedSkillSlug(slug);
  } catch (err) {
    throw new SkillUploadRequestError(formatErrorMessage(err));
  }
}

function validateOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SkillUploadRequestError("invalid offset");
  }
  return offset;
}

function validateIdempotencyKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new SkillUploadRequestError("idempotencyKey is too long");
  }
  return normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveUploadsRoot(rootDir?: string): string {
  return path.resolve(rootDir ?? path.join(resolveStateDir(), "tmp", "skill-uploads"));
}

function resolveUploadDir(rootDir: string, uploadId: string): string {
  return path.join(rootDir, validateUploadId(uploadId));
}

function resolveMetadataPath(rootDir: string, uploadId: string): string {
  return path.join(resolveUploadDir(rootDir, uploadId), "metadata.json");
}

function resolveArchivePath(rootDir: string, uploadId: string): string {
  return path.join(resolveUploadDir(rootDir, uploadId), "archive.zip");
}

function resolveIdempotencyPath(rootDir: string, keyHash: string): string {
  return path.join(rootDir, "idempotency", `${keyHash}.json`);
}

function estimateBase64DecodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Chunk(dataBase64: string): Buffer {
  const normalized = dataBase64.trim();
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new SkillUploadRequestError("invalid dataBase64");
  }
  if (normalized.length > MAX_SKILL_UPLOAD_BASE64_LENGTH) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  if (estimateBase64DecodedBytes(normalized) > MAX_SKILL_UPLOAD_CHUNK_BYTES) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length < 1) {
    throw new SkillUploadRequestError("empty upload chunk");
  }
  if (decoded.length > MAX_SKILL_UPLOAD_CHUNK_BYTES) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  return decoded;
}

async function assertNotExpired(
  rootDir: string,
  record: SkillUploadRecord,
  now: number,
): Promise<void> {
  if (record.expiresAt <= now) {
    await removeRecordFiles(rootDir, record);
    throw new SkillUploadRequestError("upload has expired");
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function readRecord(rootDir: string, uploadId: string): Promise<SkillUploadRecord> {
  const record = await readDurableJsonFile<SkillUploadRecord>(
    resolveMetadataPath(rootDir, uploadId),
  );
  if (!record || record.version !== 1 || record.uploadId !== uploadId) {
    throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
  }
  return { ...record, archivePath: resolveArchivePath(rootDir, uploadId) };
}

async function readRecordIfPresent(
  rootDir: string,
  uploadId: string,
): Promise<SkillUploadRecord | null> {
  const record = await readDurableJsonFile<SkillUploadRecord>(
    resolveMetadataPath(rootDir, uploadId),
  );
  if (!record || record.version !== 1 || record.uploadId !== uploadId) {
    return null;
  }
  return {
    ...record,
    archivePath: resolveArchivePath(rootDir, uploadId),
  };
}

async function writeRecord(rootDir: string, record: SkillUploadRecord): Promise<void> {
  await writeJsonAtomic(resolveMetadataPath(rootDir, record.uploadId), record, {
    mode: 0o600,
    dirMode: 0o700,
    trailingNewline: true,
  });
}

async function removeUploadDir(rootDir: string, uploadId: string): Promise<void> {
  await fs.rm(resolveUploadDir(rootDir, uploadId), { recursive: true, force: true });
}

async function removeRecordFiles(rootDir: string, record: SkillUploadRecord): Promise<void> {
  await removeUploadDir(rootDir, record.uploadId);
  if (record.idempotencyKeyHash) {
    await fs.rm(resolveIdempotencyPath(rootDir, record.idempotencyKeyHash), { force: true });
  }
}

async function listUploadIds(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isUploadId(entry.name))
    .map((entry) => entry.name);
}

async function cleanupExpiredUploads(
  rootDir: string,
  nowMs: number,
  excludeUploadId?: string,
): Promise<void> {
  for (const uploadId of await listUploadIds(rootDir)) {
    if (uploadId === excludeUploadId) {
      continue;
    }
    await withLock(`${rootDir}:upload:${uploadId}`, async () => {
      const record = await readRecordIfPresent(rootDir, uploadId).catch(() => null);
      if (record && record.expiresAt <= nowMs) {
        await removeRecordFiles(rootDir, record);
      }
    });
  }
}

async function countActiveUploads(rootDir: string, nowMs: number): Promise<number> {
  let count = 0;
  for (const uploadId of await listUploadIds(rootDir)) {
    const record = await readRecordIfPresent(rootDir, uploadId).catch(() => null);
    if (record && record.expiresAt > nowMs) {
      count += 1;
    }
  }
  return count;
}

async function writeArchiveChunk(params: {
  archivePath: string;
  offset: number;
  decoded: Buffer;
  afterSync: () => Promise<void>;
}): Promise<void> {
  const handle = await fs.open(params.archivePath, "r+");
  try {
    await handle.truncate(params.offset);
    let written = 0;
    while (written < params.decoded.length) {
      const result = await handle.write(
        params.decoded,
        written,
        params.decoded.length - written,
        params.offset + written,
      );
      if (result.bytesWritten <= 0) {
        throw new Error("failed to write upload chunk");
      }
      written += result.bytesWritten;
    }
    await handle.sync();
    await params.afterSync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readCommittedRecord(
  rootDir: string,
  uploadId: string,
  nowMs: number,
): Promise<SkillUploadRecord> {
  const record = await readRecord(rootDir, uploadId);
  await assertNotExpired(rootDir, record, nowMs);
  if (!record.committed) {
    throw new SkillUploadRequestError("upload is not committed");
  }
  if (!record.actualSha256) {
    throw new SkillUploadRequestError("committed upload is missing sha256");
  }
  const stat = await fs.stat(record.archivePath).catch(() => null);
  if (!stat || stat.size !== record.sizeBytes) {
    throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
  }
  return record;
}

export function createSkillUploadStore(options?: {
  rootDir?: string;
  now?: () => number;
  ttlMs?: number;
}) {
  const rootDir = resolveUploadsRoot(options?.rootDir);
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? SKILL_UPLOAD_TTL_MS;

  return {
    rootDir,
    async begin(params: BeginParams) {
      return await withLock(`${rootDir}:begin`, async () => {
        await cleanupExpiredUploads(rootDir, now());
        if (params.kind !== "skill-archive") {
          throw new SkillUploadRequestError("unsupported upload kind");
        }
        const slug = validateUploadSlug(params.slug);
        const sizeBytes = validateSizeBytes(params.sizeBytes);
        const sha256 = normalizeSkillUploadSha256(params.sha256);
        const force = params.force === true;
        const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
        const keyHash = idempotencyKey ? hashText(idempotencyKey) : undefined;
        if (keyHash) {
          const existing = await readDurableJsonFile<IdempotencyRecord>(
            resolveIdempotencyPath(rootDir, keyHash),
          );
          if (existing) {
            if (
              existing.kind !== params.kind ||
              existing.slug !== slug ||
              existing.force !== force ||
              existing.sizeBytes !== sizeBytes ||
              existing.sha256 !== sha256
            ) {
              throw new SkillUploadRequestError("idempotencyKey conflicts with a different upload");
            }
            const existingUploadId = validateUploadId(existing.uploadId);
            const activeExisting = await withLock(
              `${rootDir}:upload:${existingUploadId}`,
              async () => {
                const record = await readRecordIfPresent(rootDir, existingUploadId);
                if (record && record.expiresAt > now()) {
                  return {
                    uploadId: record.uploadId,
                    receivedBytes: record.receivedBytes,
                    expiresAt: record.expiresAt,
                  };
                }
                if (record) {
                  await removeRecordFiles(rootDir, record);
                } else {
                  await removeUploadDir(rootDir, existingUploadId);
                }
                return null;
              },
            );
            if (activeExisting) {
              return activeExisting;
            }
          }
        }

        if ((await countActiveUploads(rootDir, now())) >= MAX_ACTIVE_SKILL_UPLOADS) {
          throw new SkillUploadRequestError("too many active skill uploads");
        }

        const uploadId = randomUUID();
        const uploadDir = resolveUploadDir(rootDir, uploadId);
        const archivePath = resolveArchivePath(rootDir, uploadId);
        const createdAt = now();
        const record: SkillUploadRecord = {
          version: 1,
          kind: params.kind,
          uploadId,
          slug,
          force,
          sizeBytes,
          ...(sha256 ? { sha256 } : {}),
          receivedBytes: 0,
          archivePath,
          createdAt,
          expiresAt: createdAt + ttlMs,
          committed: false,
          ...(keyHash ? { idempotencyKeyHash: keyHash } : {}),
        };

        await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(archivePath, Buffer.alloc(0), { mode: 0o600 });
        await writeRecord(rootDir, record);
        if (keyHash) {
          const idem: IdempotencyRecord = {
            version: 1,
            keyHash,
            uploadId,
            kind: params.kind,
            slug,
            force,
            sizeBytes,
            ...(sha256 ? { sha256 } : {}),
          };
          await writeJsonAtomic(resolveIdempotencyPath(rootDir, keyHash), idem, {
            mode: 0o600,
            dirMode: 0o700,
            trailingNewline: true,
          });
        }
        return {
          uploadId,
          receivedBytes: 0,
          expiresAt: record.expiresAt,
        };
      });
    },
    async chunk(params: ChunkParams) {
      const uploadId = validateUploadId(params.uploadId);
      const offset = validateOffset(params.offset);
      const decoded = decodeBase64Chunk(params.dataBase64);
      await cleanupExpiredUploads(rootDir, now(), uploadId);
      return await withLock(`${rootDir}:upload:${uploadId}`, async () => {
        const record = await readRecord(rootDir, uploadId);
        await assertNotExpired(rootDir, record, now());
        if (record.committed) {
          throw new SkillUploadRequestError("upload is already committed");
        }
        if (offset !== record.receivedBytes) {
          throw new SkillUploadRequestError(
            `upload offset mismatch: expected ${record.receivedBytes}, got ${offset}`,
          );
        }
        const nextSize = record.receivedBytes + decoded.length;
        if (nextSize > record.sizeBytes) {
          throw new SkillUploadRequestError("upload chunk exceeds declared size");
        }
        const nextRecord = {
          ...record,
          receivedBytes: nextSize,
        };
        await writeArchiveChunk({
          archivePath: record.archivePath,
          offset: record.receivedBytes,
          decoded,
          afterSync: async () => {
            await writeRecord(rootDir, nextRecord);
          },
        });
        return {
          uploadId,
          receivedBytes: nextRecord.receivedBytes,
          expiresAt: nextRecord.expiresAt,
        };
      });
    },
    async commit(params: CommitParams) {
      const uploadId = validateUploadId(params.uploadId);
      const requestedSha = normalizeSkillUploadSha256(params.sha256);
      return await withLock(`${rootDir}:upload:${uploadId}`, async () => {
        const record = await readRecord(rootDir, uploadId);
        await assertNotExpired(rootDir, record, now());
        if (record.committed) {
          if (!record.actualSha256) {
            throw new SkillUploadRequestError("committed upload is missing sha256");
          }
          if (requestedSha && requestedSha !== record.actualSha256) {
            throw new SkillUploadRequestError("upload sha256 mismatch");
          }
          return {
            uploadId,
            receivedBytes: record.receivedBytes,
            sha256: record.actualSha256,
            expiresAt: record.expiresAt,
          };
        }
        if (record.receivedBytes !== record.sizeBytes) {
          throw new SkillUploadRequestError(
            `upload size mismatch: expected ${record.sizeBytes}, got ${record.receivedBytes}`,
          );
        }
        const stat = await fs.stat(record.archivePath).catch(() => null);
        if (!stat || stat.size !== record.sizeBytes) {
          throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
        }
        if (record.sha256 && requestedSha && record.sha256 !== requestedSha) {
          throw new SkillUploadRequestError("upload sha256 does not match begin sha256");
        }
        const actualSha256 = await computeFileSha256(record.archivePath);
        const expectedSha = requestedSha ?? record.sha256;
        if (expectedSha && expectedSha !== actualSha256) {
          throw new SkillUploadRequestError("upload sha256 mismatch");
        }
        const nextRecord = {
          ...record,
          sha256: record.sha256 ?? requestedSha ?? actualSha256,
          actualSha256,
          committed: true,
          committedAt: now(),
        };
        await writeRecord(rootDir, nextRecord);
        return {
          uploadId,
          receivedBytes: nextRecord.receivedBytes,
          sha256: actualSha256,
          expiresAt: nextRecord.expiresAt,
        };
      });
    },
    async withCommittedUpload<T>(
      uploadIdRaw: string,
      action: (record: SkillUploadRecord, controls: { remove: () => Promise<void> }) => Promise<T>,
    ): Promise<T> {
      const uploadId = validateUploadId(uploadIdRaw);
      return await withLock(`${rootDir}:upload:${uploadId}`, async () => {
        const record = await readCommittedRecord(rootDir, uploadId, now());
        return await action(record, {
          remove: async () => {
            await removeRecordFiles(rootDir, record);
          },
        });
      });
    },
    async remove(uploadIdRaw: string): Promise<void> {
      const uploadId = validateUploadId(uploadIdRaw);
      await withLock(`${rootDir}:upload:${uploadId}`, async () => {
        const record = await readDurableJsonFile<SkillUploadRecord>(
          resolveMetadataPath(rootDir, uploadId),
        );
        if (record && record.version === 1 && record.uploadId === uploadId) {
          await removeRecordFiles(rootDir, record);
        } else {
          await removeUploadDir(rootDir, uploadId);
        }
      });
    },
  };
}

export const defaultSkillUploadStore = createSkillUploadStore();
