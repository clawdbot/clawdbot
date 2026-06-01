import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile } from "./store-fs.js";

/** TTL for persisted pending uploads (matches in-memory store). */
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;

/** Cap to avoid unbounded growth if a process crashes mid-flow. */
const MAX_PENDING_UPLOADS = 100;
const MAX_CHUNKS_PER_UPLOAD = 3072;
const MAX_PENDING_UPLOAD_CHUNK_ROWS = 45_000;
const RAW_CHUNK_BYTES = 36 * 1024;
const PENDING_UPLOAD_META_MAX_ENTRIES = MAX_PENDING_UPLOADS + 100;

const STORE_FILENAME = "msteams-pending-uploads.json";
const PENDING_UPLOAD_META_NAMESPACE = "pending-uploads";
const PENDING_UPLOAD_CHUNKS_NAMESPACE = "pending-upload-chunks";
const PENDING_UPLOAD_MIGRATIONS_NAMESPACE = "pending-upload-migrations";
const PENDING_UPLOAD_LOCK_FILENAME = "msteams-pending-uploads.sqlite.lock";

type PendingUploadFsRecord = {
  id: string;
  bufferBase64: string;
  filename: string;
  contentType?: string;
  conversationId: string;
  /** Activity ID of the original FileConsentCard, used to replace it after upload */
  consentCardActivityId?: string;
  createdAt: number;
};

type PendingUploadFs = {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
  conversationId: string;
  consentCardActivityId?: string;
  createdAt: number;
};

type PendingUploadStoreData = {
  version: 1;
  uploads: Record<string, PendingUploadFsRecord>;
};

const empty: PendingUploadStoreData = { version: 1, uploads: {} };

type PendingUploadMetaRecord = Omit<PendingUploadFsRecord, "bufferBase64"> & {
  chunkCount: number;
  byteLength: number;
};

type PendingUploadChunkRecord = {
  id: string;
  index: number;
  dataBase64: string;
};

type PendingUploadMigrationMarker = {
  importedAt: string;
};

type PendingUploadsFsOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
  ttlMs?: number;
};

function resolveLegacyFilePath(options: PendingUploadsFsOptions | undefined): string {
  return resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: options?.env,
    homedir: options?.homedir,
    stateDir: options?.stateDir,
    storePath: options?.storePath,
  });
}

function createMetaStore(
  options: PendingUploadsFsOptions | undefined,
): PluginStateKeyedStore<PendingUploadMetaRecord> {
  return getMSTeamsRuntime().state.openKeyedStore<PendingUploadMetaRecord>({
    namespace: PENDING_UPLOAD_META_NAMESPACE,
    maxEntries: PENDING_UPLOAD_META_MAX_ENTRIES,
    env: resolveMSTeamsSqliteStateEnv(options),
  });
}

function createChunkStore(
  options: PendingUploadsFsOptions | undefined,
): PluginStateKeyedStore<PendingUploadChunkRecord> {
  return getMSTeamsRuntime().state.openKeyedStore<PendingUploadChunkRecord>({
    namespace: PENDING_UPLOAD_CHUNKS_NAMESPACE,
    maxEntries: MAX_PENDING_UPLOAD_CHUNK_ROWS,
    env: resolveMSTeamsSqliteStateEnv(options),
  });
}

function createMigrationStore(
  options: PendingUploadsFsOptions | undefined,
): PluginStateKeyedStore<PendingUploadMigrationMarker> {
  return getMSTeamsRuntime().state.openKeyedStore<PendingUploadMigrationMarker>({
    namespace: PENDING_UPLOAD_MIGRATIONS_NAMESPACE,
    maxEntries: 100,
    env: resolveMSTeamsSqliteStateEnv(options),
  });
}

function buildUploadKey(id: string): string {
  return `upload:${createHash("sha256").update(id).digest("hex")}`;
}

function buildMetaKey(id: string): string {
  return `${buildUploadKey(id)}:meta`;
}

function buildChunkKey(id: string, index: number): string {
  return `${buildUploadKey(id)}:chunk:${String(index).padStart(4, "0")}`;
}

function buildMigrationKey(filePath: string): string {
  return `legacy-json:${createHash("sha256").update(filePath).digest("hex")}`;
}

function buildMigrationContentKey(filePath: string, value: unknown): string {
  return `legacy-json-content:${createHash("sha256")
    .update(filePath)
    .update("\0")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")}`;
}

function pruneExpired(
  uploads: Record<string, PendingUploadFsRecord>,
  nowMs: number,
  ttlMs: number,
): Record<string, PendingUploadFsRecord> {
  const kept: Record<string, PendingUploadFsRecord> = {};
  for (const [id, record] of Object.entries(uploads)) {
    if (nowMs - record.createdAt <= ttlMs) {
      kept[id] = record;
    }
  }
  return kept;
}

function pruneToLimit(
  uploads: Record<string, PendingUploadFsRecord>,
): Record<string, PendingUploadFsRecord> {
  const entries = Object.entries(uploads);
  if (entries.length <= MAX_PENDING_UPLOADS) {
    return uploads;
  }
  // Oldest createdAt first; drop the oldest until we fit.
  entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
  const keep = entries.slice(entries.length - MAX_PENDING_UPLOADS);
  return Object.fromEntries(keep);
}

function recordToUpload(
  record: PendingUploadFsRecord | PendingUploadMetaRecord,
  buffer: Buffer,
): PendingUploadFs {
  return {
    id: record.id,
    buffer,
    filename: record.filename,
    contentType: record.contentType,
    conversationId: record.conversationId,
    consentCardActivityId: record.consentCardActivityId,
    createdAt: record.createdAt,
  };
}

function isValidStore(value: unknown): value is PendingUploadStoreData {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PendingUploadStoreData>;
  return (
    candidate.version === 1 &&
    typeof candidate.uploads === "object" &&
    candidate.uploads !== null &&
    !Array.isArray(candidate.uploads)
  );
}

function normalizeLegacyUploadRecord(value: unknown): PendingUploadFsRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<PendingUploadFsRecord>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.bufferBase64 !== "string" ||
    typeof record.filename !== "string" ||
    !record.filename ||
    typeof record.conversationId !== "string" ||
    !record.conversationId ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt)
  ) {
    return null;
  }
  return {
    id: record.id,
    bufferBase64: record.bufferBase64,
    filename: record.filename,
    contentType: typeof record.contentType === "string" ? record.contentType : undefined,
    conversationId: record.conversationId,
    consentCardActivityId:
      typeof record.consentCardActivityId === "string" ? record.consentCardActivityId : undefined,
    createdAt: record.createdAt,
  };
}

function normalizeLegacyUploads(value: unknown): Record<string, PendingUploadFsRecord> {
  if (!isValidStore(value)) {
    return {};
  }
  const uploads: Record<string, PendingUploadFsRecord> = {};
  for (const record of Object.values(value.uploads)) {
    const normalized = normalizeLegacyUploadRecord(record);
    if (normalized) {
      uploads[normalized.id] = normalized;
    }
  }
  return uploads;
}

async function deleteUploadRows(
  id: string,
  metaStore: PluginStateKeyedStore<PendingUploadMetaRecord>,
  chunkStore: PluginStateKeyedStore<PendingUploadChunkRecord>,
): Promise<void> {
  const existing = await metaStore.lookup(buildMetaKey(id));
  await metaStore.delete(buildMetaKey(id));
  if (!existing) {
    return;
  }
  const chunkCount = existing.chunkCount;
  for (let index = 0; index < chunkCount; index += 1) {
    await chunkStore.delete(buildChunkKey(id, index));
  }
}

async function registerUploadRows(
  record: PendingUploadFsRecord,
  metaStore: PluginStateKeyedStore<PendingUploadMetaRecord>,
  chunkStore: PluginStateKeyedStore<PendingUploadChunkRecord>,
  ttlMs: number,
  overwrite: boolean,
): Promise<void> {
  const buffer = Buffer.from(record.bufferBase64, "base64");
  const chunkCount = Math.max(1, Math.ceil(buffer.byteLength / RAW_CHUNK_BYTES));
  if (chunkCount > MAX_CHUNKS_PER_UPLOAD) {
    throw new Error(
      `Microsoft Teams pending upload ${record.id} exceeds SQLite chunk limit (${chunkCount}/${MAX_CHUNKS_PER_UPLOAD})`,
    );
  }
  if (overwrite) {
    await deleteUploadRows(record.id, metaStore, chunkStore);
  } else if (await metaStore.lookup(buildMetaKey(record.id))) {
    return;
  }
  await pruneUploadStore(metaStore, chunkStore, ttlMs, chunkCount);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = buffer.subarray(index * RAW_CHUNK_BYTES, (index + 1) * RAW_CHUNK_BYTES);
    await chunkStore.register(
      buildChunkKey(record.id, index),
      toPluginJsonValue({
        id: record.id,
        index,
        dataBase64: chunk.toString("base64"),
      }),
    );
  }
  await metaStore.register(
    buildMetaKey(record.id),
    toPluginJsonValue({
      id: record.id,
      filename: record.filename,
      contentType: record.contentType,
      conversationId: record.conversationId,
      consentCardActivityId: record.consentCardActivityId,
      createdAt: record.createdAt,
      chunkCount,
      byteLength: buffer.byteLength,
    }),
  );
}

async function importLegacyStore(
  options: PendingUploadsFsOptions | undefined,
  metaStore: PluginStateKeyedStore<PendingUploadMetaRecord>,
  chunkStore: PluginStateKeyedStore<PendingUploadChunkRecord>,
  ttlMs: number,
): Promise<void> {
  const legacyFilePath = resolveLegacyFilePath(options);
  const migrationStore = createMigrationStore(options);
  const migrationKey = buildMigrationKey(legacyFilePath);
  const imported = (await migrationStore.lookup(migrationKey)) !== undefined;
  const { value, exists } = await readJsonFile<unknown>(legacyFilePath, empty);
  if (!exists) {
    if (!imported) {
      await migrationStore.register(migrationKey, { importedAt: new Date().toISOString() });
    }
    return;
  }
  const contentKey = buildMigrationContentKey(legacyFilePath, value);
  if (await migrationStore.lookup(contentKey)) {
    return;
  }
  const legacy = pruneToLimit(pruneExpired(normalizeLegacyUploads(value), Date.now(), ttlMs));
  for (const record of Object.values(legacy)) {
    await registerUploadRows(record, metaStore, chunkStore, ttlMs, false);
  }
  await migrationStore.register(contentKey, { importedAt: new Date().toISOString() });
  if (!imported) {
    await migrationStore.register(migrationKey, { importedAt: new Date().toISOString() });
  }
  await fs.rm(legacyFilePath, { force: true }).catch(() => {});
}

async function withPendingUploadLock<T>(
  options: PendingUploadsFsOptions | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return await withMSTeamsSqliteMutationLock(options, PENDING_UPLOAD_LOCK_FILENAME, run);
}

async function ensureLegacyImported(
  options: PendingUploadsFsOptions | undefined,
  metaStore: PluginStateKeyedStore<PendingUploadMetaRecord>,
  chunkStore: PluginStateKeyedStore<PendingUploadChunkRecord>,
  ttlMs: number,
): Promise<void> {
  await withPendingUploadLock(options, () =>
    importLegacyStore(options, metaStore, chunkStore, ttlMs),
  );
}

async function readUploadRows(
  id: string,
  metaStore: PluginStateKeyedStore<PendingUploadMetaRecord>,
  chunkStore: PluginStateKeyedStore<PendingUploadChunkRecord>,
): Promise<PendingUploadFs | undefined> {
  const meta = await metaStore.lookup(buildMetaKey(id));
  if (!meta) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = await chunkStore.lookup(buildChunkKey(id, index));
    if (!chunk || chunk.id !== id || chunk.index !== index) {
      return undefined;
    }
    chunks.push(Buffer.from(chunk.dataBase64, "base64"));
  }
  return recordToUpload(meta, Buffer.concat(chunks, meta.byteLength));
}

async function pruneUploadStore(
  metaStore: PluginStateKeyedStore<PendingUploadMetaRecord>,
  chunkStore: PluginStateKeyedStore<PendingUploadChunkRecord>,
  ttlMs: number,
  extraChunkRows = 0,
): Promise<void> {
  const rows = await metaStore.entries();
  const liveRows = [];
  const now = Date.now();
  let liveChunkRows = 0;
  for (const row of rows) {
    if (now - row.value.createdAt > ttlMs) {
      await deleteUploadRows(row.value.id, metaStore, chunkStore);
      continue;
    }
    liveChunkRows += row.value.chunkCount;
    liveRows.push(row);
  }
  if (
    liveRows.length <= MAX_PENDING_UPLOADS &&
    liveChunkRows + extraChunkRows <= MAX_PENDING_UPLOAD_CHUNK_ROWS
  ) {
    return;
  }
  const sorted = liveRows.toSorted(
    (a, b) => a.value.createdAt - b.value.createdAt || a.value.id.localeCompare(b.value.id),
  );
  for (const row of sorted) {
    if (
      liveRows.length <= MAX_PENDING_UPLOADS &&
      liveChunkRows + extraChunkRows <= MAX_PENDING_UPLOAD_CHUNK_ROWS
    ) {
      break;
    }
    await deleteUploadRows(row.value.id, metaStore, chunkStore);
    liveChunkRows -= row.value.chunkCount;
    liveRows.pop();
  }
}

/**
 * Persist a pending upload record so another process can read it back.
 * Pass in the pre-generated id (same as the one placed in the consent card
 * context) so the in-memory and FS stores share the same key.
 */
export async function storePendingUploadFs(
  upload: {
    id: string;
    buffer: Buffer;
    filename: string;
    contentType?: string;
    conversationId: string;
    consentCardActivityId?: string;
  },
  options?: PendingUploadsFsOptions,
): Promise<void> {
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  const metaStore = createMetaStore(options);
  const chunkStore = createChunkStore(options);
  await withPendingUploadLock(options, async () => {
    await importLegacyStore(options, metaStore, chunkStore, ttlMs);
    await registerUploadRows(
      {
        id: upload.id,
        bufferBase64: upload.buffer.toString("base64"),
        filename: upload.filename,
        contentType: upload.contentType,
        conversationId: upload.conversationId,
        consentCardActivityId: upload.consentCardActivityId,
        createdAt: Date.now(),
      },
      metaStore,
      chunkStore,
      ttlMs,
      true,
    );
    await pruneUploadStore(metaStore, chunkStore, ttlMs);
  });
}

/**
 * Retrieve a persisted pending upload. Expired entries are treated as absent.
 */
export async function getPendingUploadFs(
  id: string | undefined,
  options?: PendingUploadsFsOptions,
): Promise<PendingUploadFs | undefined> {
  if (!id) {
    return undefined;
  }
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  const metaStore = createMetaStore(options);
  const chunkStore = createChunkStore(options);
  await ensureLegacyImported(options, metaStore, chunkStore, ttlMs);
  const upload = await readUploadRows(id, metaStore, chunkStore);
  if (!upload) {
    return undefined;
  }
  if (Date.now() - upload.createdAt > ttlMs) {
    await removePendingUploadFs(id, options);
    return undefined;
  }
  return upload;
}

/**
 * Remove a persisted pending upload (after successful upload or decline).
 * No-op if the entry is already gone.
 */
export async function removePendingUploadFs(
  id: string | undefined,
  options?: PendingUploadsFsOptions,
): Promise<void> {
  if (!id) {
    return;
  }
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  const metaStore = createMetaStore(options);
  const chunkStore = createChunkStore(options);
  await withPendingUploadLock(options, async () => {
    await importLegacyStore(options, metaStore, chunkStore, ttlMs);
    await deleteUploadRows(id, metaStore, chunkStore);
  });
}

/**
 * Set the consent card activity ID on a persisted entry. Called after the
 * FileConsentCard activity is sent and we know its message id.
 */
export async function setPendingUploadActivityIdFs(
  id: string,
  activityId: string,
  options?: PendingUploadsFsOptions,
): Promise<void> {
  const ttlMs = options?.ttlMs ?? PENDING_UPLOAD_TTL_MS;
  const metaStore = createMetaStore(options);
  const chunkStore = createChunkStore(options);
  await withPendingUploadLock(options, async () => {
    await importLegacyStore(options, metaStore, chunkStore, ttlMs);
    const record = await metaStore.lookup(buildMetaKey(id));
    if (!record || Date.now() - record.createdAt > ttlMs) {
      return;
    }
    await metaStore.register(
      buildMetaKey(id),
      toPluginJsonValue({ ...record, consentCardActivityId: activityId }),
    );
  });
}
