// Skill upload store persists uploaded skill archives before installation.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { DEFAULT_MAX_ARCHIVE_BYTES_ZIP } from "../../infra/archive.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createAsyncLock } from "../../infra/json-files.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withTempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { validateRequestedSkillSlug } from "./archive-install.js";
import {
  deleteOwnedSkillUpload,
  deleteSkillUploadState,
  deleteExpiredSkillUploadUnlessLeased,
  hasLiveSkillUploadInstallLease,
  openSkillUploadDatabase,
  readSkillUploadArchiveChunks,
  readSkillUploadRow,
  renewSkillUploadInstallLease,
  resolveSkillUploadDatabaseOptions,
  SKILL_UPLOAD_LEASE_SCOPE,
  type SkillUploadDatabase,
  type SkillUploadRow,
} from "./upload-store.sqlite.js";

/** Time window in which uploaded skill archive chunks may be committed. */
const SKILL_UPLOAD_TTL_MS = 60 * 60 * 1000;
const SKILL_UPLOAD_INSTALL_LEASE_MS = 15 * 60 * 1000;
const SKILL_UPLOAD_INSTALL_HEARTBEAT_MS = 30 * 1000;
const MAX_SKILL_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_SKILL_UPLOAD_CHUNK_BYTES / 3) * 4;
const MAX_ACTIVE_SKILL_UPLOADS = 32;
const SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH = 2048;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SkillUploadStoreOptions = OpenClawStateDatabaseOptions & {
  installLeaseHeartbeatMs?: number;
  installLeaseMs?: number;
  now?: () => number;
  tempRootDir?: string;
  ttlMs?: number;
};

const locks = new Map<string, { lock: ReturnType<typeof createAsyncLock>; references: number }>();

export class SkillUploadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillUploadRequestError";
  }
}

type SkillUploadRecord = {
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

function resolvePositiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function decodeBase64Chunk(dataBase64: string): Buffer {
  const normalized = dataBase64.trim();
  if (normalized.length > MAX_SKILL_UPLOAD_BASE64_LENGTH) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  if (!normalized || normalized.length % 4 !== 0) {
    throw new SkillUploadRequestError("invalid dataBase64");
  }
  const paddingLength = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const contentLength = normalized.length - paddingLength;
  for (let index = 0; index < contentLength; index += 1) {
    const code = normalized.charCodeAt(index);
    const isBase64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!isBase64Character) {
      throw new SkillUploadRequestError("invalid dataBase64");
    }
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

function requireUploadRow(uploadId: string, options: OpenClawStateDatabaseOptions): SkillUploadRow {
  const row = readSkillUploadRow(uploadId, options);
  if (!row) {
    throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
  }
  return row;
}

function assertNotExpired(
  row: SkillUploadRow,
  nowMs: number,
  options: OpenClawStateDatabaseOptions,
): void {
  const validNow = asDateTimestampMs(nowMs);
  if (validNow === undefined) {
    throw new SkillUploadRequestError("upload has expired");
  }
  if (!isFutureDateTimestampMs(row.expires_at, { nowMs: validNow })) {
    deleteExpiredSkillUploadUnlessLeased({ uploadId: row.upload_id, nowMs: validNow, options });
    throw new SkillUploadRequestError("upload has expired");
  }
}

function matchesBegin(
  row: SkillUploadRow,
  params: {
    kind: "skill-archive";
    slug: string;
    force: boolean;
    sizeBytes: number;
    sha256?: string;
  },
): boolean {
  return (
    row.kind === params.kind &&
    row.slug === params.slug &&
    row.force === (params.force ? 1 : 0) &&
    row.size_bytes === params.sizeBytes &&
    (row.sha256 ?? undefined) === params.sha256
  );
}

async function cleanupExpiredUploads(params: {
  options: OpenClawStateDatabaseOptions;
  nowMs: number;
  lockRoot: string;
  excludeUploadId?: string;
}): Promise<void> {
  const validNow = asDateTimestampMs(params.nowMs);
  if (validNow === undefined) {
    return;
  }
  const { database, kysely } = openSkillUploadDatabase(params.options);
  const expired = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("skill_uploads").select("upload_id").where("expires_at", "<=", validNow),
  ).rows;
  for (const row of expired) {
    if (row.upload_id === params.excludeUploadId) {
      continue;
    }
    await withLock(`${params.lockRoot}:upload:${row.upload_id}`, async () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const transactionDb = getNodeSqliteKysely<SkillUploadDatabase>(db);
        if (hasLiveSkillUploadInstallLease(db, transactionDb, row.upload_id, validNow)) {
          return;
        }
        const current = executeSqliteQueryTakeFirstSync(
          db,
          transactionDb
            .selectFrom("skill_uploads")
            .select("expires_at")
            .where("upload_id", "=", row.upload_id),
        );
        if (current && current.expires_at <= validNow) {
          deleteSkillUploadState(db, transactionDb, row.upload_id);
        }
      }, params.options);
    });
  }
}

function assembleArchive(
  chunks: Array<{ byte_offset: number; size_bytes: number; chunk_blob: Uint8Array }>,
  expectedSize: number,
): Buffer {
  let offset = 0;
  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.chunk_blob);
    if (chunk.byte_offset !== offset || chunk.size_bytes !== bytes.length || bytes.length < 1) {
      throw new SkillUploadRequestError("uploaded archive chunks are incomplete");
    }
    buffers.push(bytes);
    offset += bytes.length;
  }
  if (offset !== expectedSize) {
    throw new SkillUploadRequestError("uploaded archive chunks are incomplete");
  }
  return Buffer.concat(buffers, expectedSize);
}

function toRecord(row: SkillUploadRow, archivePath: string): SkillUploadRecord {
  return {
    version: 1,
    kind: "skill-archive",
    uploadId: row.upload_id,
    slug: row.slug,
    force: row.force === 1,
    sizeBytes: row.size_bytes,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.actual_sha256 ? { actualSha256: row.actual_sha256 } : {}),
    receivedBytes: row.received_bytes,
    archivePath,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    committed: row.committed === 1,
    ...(row.committed_at !== null ? { committedAt: row.committed_at } : {}),
    ...(row.idempotency_key_hash ? { idempotencyKeyHash: row.idempotency_key_hash } : {}),
  };
}

function toCommitResult(row: SkillUploadRow, requestedSha: string | undefined) {
  if (!row.actual_sha256) {
    throw new SkillUploadRequestError("committed upload is missing sha256");
  }
  if (requestedSha && requestedSha !== row.actual_sha256) {
    throw new SkillUploadRequestError("upload sha256 mismatch");
  }
  return {
    uploadId: row.upload_id,
    receivedBytes: row.received_bytes,
    sha256: row.actual_sha256,
    expiresAt: row.expires_at,
  };
}

function createSkillUploadStore(options?: SkillUploadStoreOptions) {
  const stateOptions = resolveSkillUploadDatabaseOptions(options ?? {});
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? SKILL_UPLOAD_TTL_MS;
  const tempRootDir = options?.tempRootDir;
  const installLeaseMs = resolvePositiveDuration(
    options?.installLeaseMs,
    SKILL_UPLOAD_INSTALL_LEASE_MS,
  );
  const installLeaseHeartbeatMs = resolvePositiveDuration(
    options?.installLeaseHeartbeatMs,
    SKILL_UPLOAD_INSTALL_HEARTBEAT_MS,
  );

  function lockRoot(): string {
    return openOpenClawStateDatabase(stateOptions).path;
  }

  return {
    async begin(params: BeginParams) {
      const root = lockRoot();
      return await withLock(`${root}:begin`, async () => {
        await cleanupExpiredUploads({ options: stateOptions, nowMs: now(), lockRoot: root });
        if (params.kind !== "skill-archive") {
          throw new SkillUploadRequestError("unsupported upload kind");
        }
        const slug = validateUploadSlug(params.slug);
        const sizeBytes = validateSizeBytes(params.sizeBytes);
        const sha256 = normalizeSkillUploadSha256(params.sha256);
        const force = params.force === true;
        const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
        const keyHash = idempotencyKey ? sha256Hex(idempotencyKey) : undefined;
        // Expiry begins after cleanup waits, not before a possibly long in-flight install.
        const createdAt = now();
        const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: createdAt });
        if (expiresAt === undefined) {
          throw new SkillUploadRequestError("invalid upload expiry");
        }

        return runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
          if (keyHash) {
            const existing = executeSqliteQueryTakeFirstSync(
              db,
              kysely
                .selectFrom("skill_uploads")
                .selectAll()
                .where("idempotency_key_hash", "=", keyHash),
            );
            if (existing) {
              if (!matchesBegin(existing, { kind: params.kind, slug, force, sizeBytes, sha256 })) {
                throw new SkillUploadRequestError(
                  "idempotencyKey conflicts with a different upload",
                );
              }
              if (isFutureDateTimestampMs(existing.expires_at, { nowMs: createdAt })) {
                return {
                  uploadId: existing.upload_id,
                  receivedBytes: existing.received_bytes,
                  expiresAt: existing.expires_at,
                };
              }
              if (hasLiveSkillUploadInstallLease(db, kysely, existing.upload_id, createdAt)) {
                throw new SkillUploadRequestError("upload is already being installed");
              }
              deleteSkillUploadState(db, kysely, existing.upload_id);
            }
          }

          const activeCount = executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("skill_uploads")
              .select("upload_id")
              .where("expires_at", ">", createdAt)
              .limit(MAX_ACTIVE_SKILL_UPLOADS),
          ).rows.length;
          if (activeCount >= MAX_ACTIVE_SKILL_UPLOADS) {
            throw new SkillUploadRequestError("too many active skill uploads");
          }

          const uploadId = randomUUID();
          executeSqliteQuerySync(
            db,
            kysely.insertInto("skill_uploads").values({
              upload_id: uploadId,
              kind: params.kind,
              slug,
              force: force ? 1 : 0,
              size_bytes: sizeBytes,
              sha256: sha256 ?? null,
              actual_sha256: null,
              received_bytes: 0,
              archive_blob: Buffer.alloc(0),
              created_at: createdAt,
              expires_at: expiresAt,
              committed: 0,
              committed_at: null,
              idempotency_key_hash: keyHash ?? null,
            }),
          );
          return { uploadId, receivedBytes: 0, expiresAt };
        }, stateOptions);
      });
    },

    async chunk(params: ChunkParams) {
      const uploadId = validateUploadId(params.uploadId);
      const offset = validateOffset(params.offset);
      const decoded = decodeBase64Chunk(params.dataBase64);
      const root = lockRoot();
      await cleanupExpiredUploads({
        options: stateOptions,
        nowMs: now(),
        lockRoot: root,
        excludeUploadId: uploadId,
      });
      return await withLock(`${root}:upload:${uploadId}`, async () => {
        const currentTime = now();
        assertNotExpired(requireUploadRow(uploadId, stateOptions), currentTime, stateOptions);
        return runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
          const row = executeSqliteQueryTakeFirstSync(
            db,
            kysely.selectFrom("skill_uploads").selectAll().where("upload_id", "=", uploadId),
          );
          if (!row) {
            throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
          }
          const validNow = asDateTimestampMs(currentTime);
          if (
            validNow === undefined ||
            !isFutureDateTimestampMs(row.expires_at, { nowMs: validNow })
          ) {
            throw new SkillUploadRequestError("upload has expired");
          }
          if (row.committed === 1) {
            throw new SkillUploadRequestError("upload is already committed");
          }
          if (offset !== row.received_bytes) {
            throw new SkillUploadRequestError(
              `upload offset mismatch: expected ${row.received_bytes}, got ${offset}`,
            );
          }
          const nextSize = row.received_bytes + decoded.length;
          if (nextSize > row.size_bytes) {
            throw new SkillUploadRequestError("upload chunk exceeds declared size");
          }
          executeSqliteQuerySync(
            db,
            kysely.insertInto("skill_upload_chunks").values({
              upload_id: uploadId,
              byte_offset: offset,
              size_bytes: decoded.length,
              chunk_blob: decoded,
            }),
          );
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("skill_uploads")
              .set({ received_bytes: nextSize })
              .where("upload_id", "=", uploadId),
          );
          return { uploadId, receivedBytes: nextSize, expiresAt: row.expires_at };
        }, stateOptions);
      });
    },

    async commit(params: CommitParams) {
      const uploadId = validateUploadId(params.uploadId);
      const requestedSha = normalizeSkillUploadSha256(params.sha256);
      const root = lockRoot();
      return await withLock(`${root}:upload:${uploadId}`, async () => {
        const row = requireUploadRow(uploadId, stateOptions);
        assertNotExpired(row, now(), stateOptions);
        if (row.committed === 1) {
          return toCommitResult(row, requestedSha);
        }
        if (row.received_bytes !== row.size_bytes) {
          throw new SkillUploadRequestError(
            `upload size mismatch: expected ${row.size_bytes}, got ${row.received_bytes}`,
          );
        }
        if (row.sha256 && requestedSha && row.sha256 !== requestedSha) {
          throw new SkillUploadRequestError("upload sha256 does not match begin sha256");
        }

        let archive: Buffer;
        try {
          archive = assembleArchive(
            readSkillUploadArchiveChunks(uploadId, stateOptions),
            row.size_bytes,
          );
        } catch (err) {
          // Another process may commit and delete chunks after our metadata read.
          // The committed parent row is the idempotent authority in that race.
          const current = requireUploadRow(uploadId, stateOptions);
          if (current.committed === 1) {
            return toCommitResult(current, requestedSha);
          }
          throw err;
        }
        const actualSha256 = sha256Hex(archive);
        const expectedSha = requestedSha ?? row.sha256 ?? undefined;
        if (expectedSha && expectedSha !== actualSha256) {
          throw new SkillUploadRequestError("upload sha256 mismatch");
        }
        const committedAt = now();
        assertNotExpired(requireUploadRow(uploadId, stateOptions), committedAt, stateOptions);

        return runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
          const current = executeSqliteQueryTakeFirstSync(
            db,
            kysely.selectFrom("skill_uploads").selectAll().where("upload_id", "=", uploadId),
          );
          if (!current) {
            throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
          }
          if (current.committed === 1) {
            return toCommitResult(current, requestedSha);
          }
          if (!isFutureDateTimestampMs(current.expires_at, { nowMs: committedAt })) {
            throw new SkillUploadRequestError("upload has expired");
          }
          if (
            current.received_bytes !== current.size_bytes ||
            current.size_bytes !== archive.length
          ) {
            throw new SkillUploadRequestError("uploaded archive chunks changed during commit");
          }
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("skill_uploads")
              .set({
                actual_sha256: actualSha256,
                archive_blob: archive,
                committed: 1,
                committed_at: committedAt,
              })
              .where("upload_id", "=", uploadId),
          );
          executeSqliteQuerySync(
            db,
            kysely.deleteFrom("skill_upload_chunks").where("upload_id", "=", uploadId),
          );
          return {
            uploadId,
            receivedBytes: current.received_bytes,
            sha256: actualSha256,
            expiresAt: current.expires_at,
          };
        }, stateOptions);
      });
    },

    async withCommittedUpload<T>(
      uploadIdRaw: string,
      action: (record: SkillUploadRecord, controls: { remove: () => Promise<void> }) => Promise<T>,
    ): Promise<T> {
      const uploadId = validateUploadId(uploadIdRaw);
      const root = lockRoot();
      return await withLock(`${root}:upload:${uploadId}`, async () => {
        const leaseOwner = randomUUID();
        const currentTime = now();
        assertNotExpired(requireUploadRow(uploadId, stateOptions), currentTime, stateOptions);
        const row = runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
          const current = executeSqliteQueryTakeFirstSync(
            db,
            kysely.selectFrom("skill_uploads").selectAll().where("upload_id", "=", uploadId),
          );
          if (!current) {
            throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
          }
          const validNow = asDateTimestampMs(currentTime);
          if (
            validNow === undefined ||
            !isFutureDateTimestampMs(current.expires_at, { nowMs: validNow })
          ) {
            throw new SkillUploadRequestError("upload has expired");
          }
          if (current.committed !== 1) {
            throw new SkillUploadRequestError("upload is not committed");
          }
          if (!current.actual_sha256) {
            throw new SkillUploadRequestError("committed upload is missing sha256");
          }
          if (Buffer.from(current.archive_blob).length !== current.size_bytes) {
            throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
          }
          executeSqliteQuerySync(
            db,
            kysely
              .deleteFrom("state_leases")
              .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
              .where("lease_key", "=", uploadId)
              .where("expires_at", "<=", currentTime),
          );
          const claimed = executeSqliteQuerySync(
            db,
            kysely
              .insertInto("state_leases")
              .values({
                scope: SKILL_UPLOAD_LEASE_SCOPE,
                lease_key: uploadId,
                owner: leaseOwner,
                expires_at: currentTime + installLeaseMs,
                heartbeat_at: currentTime,
                payload_json: null,
                created_at: currentTime,
                updated_at: currentTime,
              })
              .onConflict((conflict) => conflict.doNothing()),
          );
          if (claimed.numAffectedRows !== 1n) {
            throw new SkillUploadRequestError("upload is already being installed");
          }
          return current;
        }, stateOptions);

        // The callback can cross process-local lock lifetimes. Keep the SQLite owner lease
        // alive until it settles so another Gateway cannot sweep or reinstall this upload.
        const heartbeat = setInterval(() => {
          const heartbeatAt = now();
          try {
            renewSkillUploadInstallLease({
              uploadId,
              owner: leaseOwner,
              heartbeatAt,
              expiresAt: heartbeatAt + installLeaseMs,
              options: stateOptions,
            });
          } catch {
            // A transient busy/error keeps the existing generous lease; the next tick retries.
          }
        }, installLeaseHeartbeatMs);
        heartbeat.unref();

        try {
          return await withTempWorkspace(
            {
              rootDir: tempRootDir ?? resolvePreferredOpenClawTmpDir(),
              prefix: "openclaw-skill-upload-",
            },
            async (tmp) => {
              const archivePath = path.join(tmp.dir, "archive.zip");
              await fs.writeFile(archivePath, Buffer.from(row.archive_blob), { mode: 0o600 });
              return await action(toRecord(row, archivePath), {
                remove: async () => {
                  // Only the callback that still owns the install lease may consume the upload.
                  // A stalled callback must not erase a successor Gateway's replacement lease.
                  if (
                    deleteOwnedSkillUpload(uploadId, leaseOwner, now(), stateOptions) ===
                    "not-owner"
                  ) {
                    throw new SkillUploadRequestError("upload install lease is no longer active");
                  }
                },
              });
            },
          );
        } finally {
          clearInterval(heartbeat);
          runOpenClawStateWriteTransaction(({ db }) => {
            const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
            executeSqliteQuerySync(
              db,
              kysely
                .deleteFrom("state_leases")
                .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
                .where("lease_key", "=", uploadId)
                .where("owner", "=", leaseOwner),
            );
          }, stateOptions);
        }
      });
    },
  };
}

export const defaultSkillUploadStore = createSkillUploadStore();

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.skillUploadStoreTestApi")] = {
    createSkillUploadStore,
  };
}
