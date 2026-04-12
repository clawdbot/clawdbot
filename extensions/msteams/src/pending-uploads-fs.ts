/**
 * Filesystem-backed pending upload store for the FileConsentCard flow.
 *
 * The CLI `message send --media` path runs in a different process from the
 * gateway's bot monitor that receives the `fileConsent/invoke` callback.
 * An in-memory `pending-uploads.ts` store cannot bridge those processes, so
 * when the user clicks "Allow" the monitor handler's lookup misses and the
 * user sees "card action not supported".
 *
 * This FS store persists pending uploads to a JSON file (with the file buffer
 * base64-encoded) so any process that shares the OpenClaw state dir can read
 * them back. The in-memory store in `pending-uploads.ts` is still the fast
 * path for same-process flows (for example the messenger reply path); this FS
 * store is a cross-process fallback.
 */

import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

/** TTL for persisted pending uploads (matches in-memory store). */
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;

/** Cap to avoid unbounded growth if a process crashes mid-flow. */
const MAX_PENDING_UPLOADS = 100;

const STORE_FILENAME = "msteams-pending-uploads.json";

export type PendingUploadFsRecord = {
  id: string;
  bufferBase64: string;
  filename: string;
  contentType?: string;
  conversationId: string;
  /** Activity ID of the original FileConsentCard, used to replace it after upload */
  consentCardActivityId?: string;
  createdAt: number;
};

export type PendingUploadFs = {
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

export type PendingUploadsFsOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
  ttlMs?: number;
};

function resolveFilePath(options: PendingUploadsFsOptions | undefined): string {
  return resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: options?.env,
    homedir: options?.homedir,
    stateDir: options?.stateDir,
    storePath: options?.storePath,
  });
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

function recordToUpload(record: PendingUploadFsRecord): PendingUploadFs {
  return {
    id: record.id,
    buffer: Buffer.from(record.bufferBase64, "base64"),
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

async function readStore(filePath: string, ttlMs: number): Promise<PendingUploadStoreData> {
  const { value } = await readJsonFile<unknown>(filePath, empty);
  if (!isValidStore(value)) {
    return { version: 1, uploads: {} };
  }
  const uploads = pruneToLimit(pruneExpired(value.uploads, Date.now(), ttlMs));
  return { version: 1, uploads };
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
  const filePath = resolveFilePath(options);
  await withFileLock(filePath, empty, async () => {
    const store = await readStore(filePath, ttlMs);
    store.uploads[upload.id] = {
      id: upload.id,
      bufferBase64: upload.buffer.toString("base64"),
      filename: upload.filename,
      contentType: upload.contentType,
      conversationId: upload.conversationId,
      consentCardActivityId: upload.consentCardActivityId,
      createdAt: Date.now(),
    };
    store.uploads = pruneToLimit(pruneExpired(store.uploads, Date.now(), ttlMs));
    await writeJsonFile(filePath, store);
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
  const filePath = resolveFilePath(options);
  const store = await readStore(filePath, ttlMs);
  const record = store.uploads[id];
  if (!record) {
    return undefined;
  }
  if (Date.now() - record.createdAt > ttlMs) {
    return undefined;
  }
  return recordToUpload(record);
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
  const filePath = resolveFilePath(options);
  await withFileLock(filePath, empty, async () => {
    const store = await readStore(filePath, ttlMs);
    if (!(id in store.uploads)) {
      return;
    }
    delete store.uploads[id];
    await writeJsonFile(filePath, store);
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
  const filePath = resolveFilePath(options);
  await withFileLock(filePath, empty, async () => {
    const store = await readStore(filePath, ttlMs);
    const record = store.uploads[id];
    if (!record) {
      return;
    }
    record.consentCardActivityId = activityId;
    await writeJsonFile(filePath, store);
  });
}
