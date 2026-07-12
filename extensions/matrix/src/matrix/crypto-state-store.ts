// Matrix plugin module owns SQLite-backed crypto state sidecars.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "../record-shared.js";
import { getMatrixRuntime } from "../runtime.js";
import type { MatrixStoredRecoveryKey } from "./sdk/types.js";
import { resolveMatrixSqliteStateEnv } from "./sqlite-state.js";

const STATE_KEY = "current";
const RECOVERY_KEY_NAMESPACE = "recovery-key";
const LEGACY_CRYPTO_MIGRATION_NAMESPACE = "legacy-crypto-migration";
const IDB_SNAPSHOT_NAMESPACE = "idb-snapshot";
const SMALL_STATE_MAX_ENTRIES = 10;
const IDB_SNAPSHOT_MAX_ENTRIES = 20_000;
const IDB_SNAPSHOT_MAX_CHUNKS = Math.floor((IDB_SNAPSHOT_MAX_ENTRIES - 1) / 2);
const IDB_SNAPSHOT_CHUNK_BYTES = 24_000;

export const MATRIX_RECOVERY_KEY_FILENAME = "recovery-key.json";
export const MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME = "legacy-crypto-migration.json";
export const MATRIX_IDB_SNAPSHOT_FILENAME = "crypto-idb-snapshot.json";

export type MatrixLegacyCryptoCounts = {
  total: number;
  backedUp: number;
};

export type MatrixLegacyCryptoMigrationState = {
  version: 1;
  source?: "matrix-bot-sdk-rust";
  accountId: string;
  deviceId?: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion?: string | null;
  decryptionKeyImported?: boolean;
  restoreStatus: "pending" | "completed" | "manual-action-required";
  detectedAt?: string;
  restoredAt?: string;
  importedCount?: number;
  totalCount?: number;
  lastError?: string | null;
};

type MatrixIdbSnapshotMeta = {
  kind: "meta";
  version: 1;
  generation: string;
  chunkCount: number;
  digest: string;
  databaseCount: number;
  persistedAt: string;
};

type MatrixIdbSnapshotChunk = {
  kind: "snapshot-chunk";
  index: number;
  data: string;
};

export type MatrixIdbSnapshotRecord = MatrixIdbSnapshotMeta | MatrixIdbSnapshotChunk;

type AsyncStore<T> = Pick<PluginStateKeyedStore<T>, "delete" | "entries" | "lookup" | "register">;
type SyncStore<T> = Pick<
  PluginStateSyncKeyedStore<T>,
  "delete" | "entries" | "lookup" | "register"
>;

export function openMatrixRecoveryKeyStoreOptions(storageRootDir: string) {
  return {
    namespace: RECOVERY_KEY_NAMESPACE,
    maxEntries: SMALL_STATE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export function openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir: string) {
  return {
    namespace: LEGACY_CRYPTO_MIGRATION_NAMESPACE,
    maxEntries: SMALL_STATE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export function openMatrixIdbSnapshotStoreOptions(storageRootDir: string) {
  return {
    namespace: IDB_SNAPSHOT_NAMESPACE,
    maxEntries: IDB_SNAPSHOT_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export function readMatrixRecoveryKeyState(storageRootDir: string): MatrixStoredRecoveryKey | null {
  return readMatrixRecoveryKeyStateWithKey({
    storageRootDir,
    stateKey: STATE_KEY,
  });
}

export function readMatrixRecoveryKeyStateForPath(
  recoveryKeyPath: string,
): MatrixStoredRecoveryKey | null {
  return readMatrixRecoveryKeyStateWithKey({
    storageRootDir: path.dirname(recoveryKeyPath),
    stateKey: resolveRecoveryKeyStateKeyForPath(recoveryKeyPath),
  });
}

function readMatrixRecoveryKeyStateWithKey(params: {
  storageRootDir: string;
  stateKey: string;
}): MatrixStoredRecoveryKey | null {
  return normalizeMatrixStoredRecoveryKey(
    openSyncStore<MatrixStoredRecoveryKey>(
      openMatrixRecoveryKeyStoreOptions(params.storageRootDir),
    ).lookup(params.stateKey),
  );
}

export function writeMatrixRecoveryKeyStateForPath(params: {
  recoveryKeyPath: string;
  payload: MatrixStoredRecoveryKey;
}): void {
  writeMatrixRecoveryKeyStateWithKey({
    storageRootDir: path.dirname(params.recoveryKeyPath),
    stateKey: resolveRecoveryKeyStateKeyForPath(params.recoveryKeyPath),
    payload: params.payload,
  });
}

function writeMatrixRecoveryKeyStateWithKey(params: {
  storageRootDir: string;
  stateKey: string;
  payload: MatrixStoredRecoveryKey;
}): void {
  const payload = normalizeMatrixStoredRecoveryKey(params.payload);
  if (!payload) {
    throw new Error("Invalid Matrix recovery key state");
  }
  openSyncStore<MatrixStoredRecoveryKey>(
    openMatrixRecoveryKeyStoreOptions(params.storageRootDir),
  ).register(params.stateKey, payload);
}

export async function hasMatrixRecoveryKeyStateInStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixStoredRecoveryKey>, "lookup">;
}): Promise<boolean> {
  return normalizeMatrixStoredRecoveryKey(await params.store.lookup(STATE_KEY)) !== null;
}

export async function writeMatrixRecoveryKeyStateToStore(params: {
  payload: MatrixStoredRecoveryKey;
  store: Pick<PluginStateKeyedStore<MatrixStoredRecoveryKey>, "register">;
}): Promise<void> {
  const payload = normalizeMatrixStoredRecoveryKey(params.payload);
  if (!payload) {
    throw new Error("Invalid Matrix recovery key state");
  }
  await params.store.register(STATE_KEY, payload);
}

export function readMatrixLegacyCryptoMigrationState(
  storageRootDir: string,
): MatrixLegacyCryptoMigrationState | null {
  return normalizeMatrixLegacyCryptoMigrationState(
    openSyncStore<MatrixLegacyCryptoMigrationState>(
      openMatrixLegacyCryptoMigrationStoreOptions(storageRootDir),
    ).lookup(STATE_KEY),
  );
}

export function writeMatrixLegacyCryptoMigrationState(params: {
  storageRootDir: string;
  state: MatrixLegacyCryptoMigrationState;
}): void {
  const state = normalizeMatrixLegacyCryptoMigrationState(params.state);
  if (!state) {
    throw new Error("Invalid Matrix legacy crypto migration state");
  }
  openSyncStore<MatrixLegacyCryptoMigrationState>(
    openMatrixLegacyCryptoMigrationStoreOptions(params.storageRootDir),
  ).register(STATE_KEY, state);
}

export async function hasMatrixLegacyCryptoMigrationStateInStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixLegacyCryptoMigrationState>, "lookup">;
}): Promise<boolean> {
  return normalizeMatrixLegacyCryptoMigrationState(await params.store.lookup(STATE_KEY)) !== null;
}

export async function writeMatrixLegacyCryptoMigrationStateToStore(params: {
  state: MatrixLegacyCryptoMigrationState;
  store: Pick<PluginStateKeyedStore<MatrixLegacyCryptoMigrationState>, "register">;
}): Promise<void> {
  const state = normalizeMatrixLegacyCryptoMigrationState(params.state);
  if (!state) {
    throw new Error("Invalid Matrix legacy crypto migration state");
  }
  await params.store.register(STATE_KEY, state);
}

export function readMatrixIdbSnapshotJson(storageRootDir: string): string | null {
  return readIdbSnapshotJsonFromStore(
    openSyncStore<MatrixIdbSnapshotRecord>(openMatrixIdbSnapshotStoreOptions(storageRootDir)),
  );
}

function hasMatrixIdbSnapshotState(storageRootDir: string): boolean {
  return isIdbSnapshotMeta(
    openSyncStore<MatrixIdbSnapshotRecord>(
      openMatrixIdbSnapshotStoreOptions(storageRootDir),
    ).lookup(idbMetaKey()),
  );
}

export function writeMatrixIdbSnapshotJson(params: {
  storageRootDir: string;
  snapshotJson: string;
  databaseCount: number;
}): void {
  writeIdbSnapshotJsonToStore({
    snapshotJson: params.snapshotJson,
    databaseCount: params.databaseCount,
    store: openSyncStore<MatrixIdbSnapshotRecord>(
      openMatrixIdbSnapshotStoreOptions(params.storageRootDir),
    ),
  });
}

export async function hasMatrixIdbSnapshotStateInStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixIdbSnapshotRecord>, "lookup">;
}): Promise<boolean> {
  return (await readIdbSnapshotJsonFromAsyncStore(params.store)) !== null;
}

export async function writeMatrixIdbSnapshotJsonToStore(params: {
  snapshotJson: string;
  databaseCount: number;
  store: AsyncStore<MatrixIdbSnapshotRecord>;
}): Promise<void> {
  const rows = buildIdbSnapshotRows(params.snapshotJson, params.databaseCount);
  for (const row of rows.chunks) {
    await params.store.register(row.key, row.value);
  }
  await params.store.register(rows.meta.key, rows.meta.value);
  for (const row of await params.store.entries()) {
    if (row.key.startsWith(idbChunkKeyPrefix()) && !rows.nextChunkKeys.has(row.key)) {
      await params.store.delete(row.key);
    }
  }
}

export function migrateLegacyMatrixRecoveryKeyFileToStore(storageRootDir: string): boolean {
  return migrateLegacyMatrixRecoveryKeyFilePathToStore(
    path.join(storageRootDir, MATRIX_RECOVERY_KEY_FILENAME),
  );
}

export function migrateLegacyMatrixRecoveryKeyFilePathToStore(recoveryKeyPath: string): boolean {
  const existing = readMatrixRecoveryKeyStateForPath(recoveryKeyPath);
  const legacy = readLegacyMatrixRecoveryKeyFile(recoveryKeyPath);
  if (!existing && legacy) {
    writeMatrixRecoveryKeyStateForPath({ recoveryKeyPath, payload: legacy });
  }
  return archiveLegacyStateFileIfPossible(recoveryKeyPath);
}

export function migrateLegacyMatrixLegacyCryptoMigrationFileToStore(
  storageRootDir: string,
): boolean {
  const existing = readMatrixLegacyCryptoMigrationState(storageRootDir);
  const legacy = readLegacyMatrixLegacyCryptoMigrationState(storageRootDir);
  if (!existing && legacy) {
    writeMatrixLegacyCryptoMigrationState({ storageRootDir, state: legacy });
  }
  return archiveLegacyStateFileIfPossible(
    path.join(storageRootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
  );
}

export function readLegacyMatrixRecoveryKeyState(
  storageRootDir: string,
): MatrixStoredRecoveryKey | null {
  return readLegacyMatrixRecoveryKeyFile(path.join(storageRootDir, MATRIX_RECOVERY_KEY_FILENAME));
}

export function readLegacyMatrixRecoveryKeyFile(filePath: string): MatrixStoredRecoveryKey | null {
  return readJsonFileSync(filePath, normalizeMatrixStoredRecoveryKey);
}

export function readLegacyMatrixLegacyCryptoMigrationState(
  storageRootDir: string,
): MatrixLegacyCryptoMigrationState | null {
  return readJsonFileSync(
    path.join(storageRootDir, MATRIX_LEGACY_CRYPTO_MIGRATION_FILENAME),
    normalizeMatrixLegacyCryptoMigrationState,
  );
}

export function scoreMatrixCryptoStateInStore(storageRootDir: string): number {
  if (!matrixCryptoStateDatabaseExists(storageRootDir)) {
    return 0;
  }
  let score = 0;
  try {
    if (readMatrixLegacyCryptoMigrationState(storageRootDir)) {
      score += 3;
    }
  } catch {
    // Storage root scoring must stay best-effort; unreadable state should not block startup.
  }
  try {
    if (readMatrixRecoveryKeyState(storageRootDir)) {
      score += 2;
    }
  } catch {
    // Storage root scoring must stay best-effort; unreadable state should not block startup.
  }
  try {
    if (hasMatrixIdbSnapshotState(storageRootDir)) {
      score += 2;
    }
  } catch {
    // Storage root scoring must stay best-effort; unreadable state should not block startup.
  }
  return score;
}

function matrixCryptoStateDatabaseExists(storageRootDir: string): boolean {
  return fs.existsSync(path.join(storageRootDir, "state", "openclaw.sqlite"));
}

function resolveRecoveryKeyStateKeyForPath(recoveryKeyPath: string): string {
  const basename = path.basename(recoveryKeyPath);
  if (basename === MATRIX_RECOVERY_KEY_FILENAME) {
    return STATE_KEY;
  }
  return `file:${createHash("sha256").update(basename, "utf8").digest("hex").slice(0, 32)}`;
}

function normalizeMatrixStoredRecoveryKey(value: unknown): MatrixStoredRecoveryKey | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.privateKeyBase64 !== "string" ||
    !value.privateKeyBase64.trim()
  ) {
    return null;
  }
  return {
    version: 1,
    createdAt: value.createdAt,
    keyId: typeof value.keyId === "string" ? value.keyId : null,
    ...(typeof value.encodedPrivateKey === "string"
      ? { encodedPrivateKey: value.encodedPrivateKey }
      : {}),
    privateKeyBase64: value.privateKeyBase64,
    ...(isRecord(value.keyInfo)
      ? {
          keyInfo: {
            ...(value.keyInfo.passphrase !== undefined
              ? { passphrase: value.keyInfo.passphrase }
              : {}),
            ...(typeof value.keyInfo.name === "string" ? { name: value.keyInfo.name } : {}),
          },
        }
      : {}),
  };
}

function normalizeMatrixLegacyCryptoMigrationState(
  value: unknown,
): MatrixLegacyCryptoMigrationState | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.accountId !== "string") {
    return null;
  }
  if (
    value.restoreStatus !== "pending" &&
    value.restoreStatus !== "completed" &&
    value.restoreStatus !== "manual-action-required"
  ) {
    return null;
  }
  const roomKeyCounts =
    isRecord(value.roomKeyCounts) &&
    typeof value.roomKeyCounts.total === "number" &&
    typeof value.roomKeyCounts.backedUp === "number"
      ? {
          total: value.roomKeyCounts.total,
          backedUp: value.roomKeyCounts.backedUp,
        }
      : null;
  return {
    version: 1,
    ...(value.source === "matrix-bot-sdk-rust" ? { source: value.source } : {}),
    accountId: value.accountId,
    ...(typeof value.deviceId === "string" || value.deviceId === null
      ? { deviceId: value.deviceId }
      : {}),
    roomKeyCounts,
    ...(typeof value.backupVersion === "string" || value.backupVersion === null
      ? { backupVersion: value.backupVersion }
      : {}),
    ...(typeof value.decryptionKeyImported === "boolean"
      ? { decryptionKeyImported: value.decryptionKeyImported }
      : {}),
    restoreStatus: value.restoreStatus,
    ...(typeof value.detectedAt === "string" ? { detectedAt: value.detectedAt } : {}),
    ...(typeof value.restoredAt === "string" ? { restoredAt: value.restoredAt } : {}),
    ...(typeof value.importedCount === "number" ? { importedCount: value.importedCount } : {}),
    ...(typeof value.totalCount === "number" ? { totalCount: value.totalCount } : {}),
    ...(typeof value.lastError === "string" || value.lastError === null
      ? { lastError: value.lastError }
      : {}),
  };
}

function openSyncStore<T>(options: {
  namespace: string;
  maxEntries: number;
  env?: NodeJS.ProcessEnv;
}): PluginStateSyncKeyedStore<T> {
  return getMatrixRuntime().state.openSyncKeyedStore<T>(options);
}

function readJsonFileSync<T>(filePath: string, normalize: (value: unknown) => T | null): T | null {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function archiveLegacyStateFileIfPossible(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const archivedPath = `${filePath}.migrated`;
  if (fs.existsSync(archivedPath)) {
    return false;
  }
  fs.renameSync(filePath, archivedPath);
  return true;
}

function readIdbSnapshotJsonFromStore(store: Pick<SyncStore<MatrixIdbSnapshotRecord>, "lookup">) {
  const meta = store.lookup(idbMetaKey());
  if (!isIdbSnapshotMeta(meta)) {
    return null;
  }
  const chunks = readIdbSnapshotChunks(meta, (key) => store.lookup(key));
  return chunks ? chunks.join("") : null;
}

async function readIdbSnapshotJsonFromAsyncStore(
  store: Pick<PluginStateKeyedStore<MatrixIdbSnapshotRecord>, "lookup">,
): Promise<string | null> {
  const meta = await store.lookup(idbMetaKey());
  if (!isIdbSnapshotMeta(meta)) {
    return null;
  }
  const chunks = await readIdbSnapshotChunksAsync(meta, (key) => store.lookup(key));
  return chunks ? chunks.join("") : null;
}

function readIdbSnapshotChunks(
  meta: MatrixIdbSnapshotMeta,
  lookup: (key: string) => MatrixIdbSnapshotRecord | undefined,
): string[] | null {
  const chunks: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = lookup(idbChunkKey(meta.generation, index));
    if (!isIdbSnapshotChunk(chunk) || chunk.index !== index) {
      return null;
    }
    chunks.push(chunk.data);
  }
  const snapshotJson = chunks.join("");
  if (meta.digest !== digestText(snapshotJson)) {
    return null;
  }
  return chunks;
}

async function readIdbSnapshotChunksAsync(
  meta: MatrixIdbSnapshotMeta,
  lookup: (key: string) => Promise<MatrixIdbSnapshotRecord | undefined>,
): Promise<string[] | null> {
  const chunks: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = await lookup(idbChunkKey(meta.generation, index));
    if (!isIdbSnapshotChunk(chunk) || chunk.index !== index) {
      return null;
    }
    chunks.push(chunk.data);
  }
  const snapshotJson = chunks.join("");
  if (meta.digest !== digestText(snapshotJson)) {
    return null;
  }
  return chunks;
}

function writeIdbSnapshotJsonToStore(params: {
  snapshotJson: string;
  databaseCount: number;
  store: SyncStore<MatrixIdbSnapshotRecord>;
}): void {
  const rows = buildIdbSnapshotRows(params.snapshotJson, params.databaseCount);
  for (const row of rows.chunks) {
    params.store.register(row.key, row.value);
  }
  params.store.register(rows.meta.key, rows.meta.value);
  for (const row of params.store.entries()) {
    if (row.key.startsWith(idbChunkKeyPrefix()) && !rows.nextChunkKeys.has(row.key)) {
      params.store.delete(row.key);
    }
  }
}

function buildIdbSnapshotRows(
  snapshotJson: string,
  databaseCount: number,
): {
  meta: { key: string; value: MatrixIdbSnapshotMeta };
  chunks: { key: string; value: MatrixIdbSnapshotChunk }[];
  nextChunkKeys: Set<string>;
} {
  const generation = randomUUID().replaceAll("-", "");
  const chunks = chunkText(snapshotJson).map((data, index) => ({
    key: idbChunkKey(generation, index),
    value: {
      kind: "snapshot-chunk" as const,
      index,
      data,
    },
  }));
  return {
    chunks,
    nextChunkKeys: new Set(chunks.map((chunk) => chunk.key)),
    meta: {
      key: idbMetaKey(),
      value: {
        kind: "meta",
        version: 1,
        generation,
        chunkCount: chunks.length,
        digest: digestText(snapshotJson),
        databaseCount,
        persistedAt: new Date().toISOString(),
      },
    },
  };
}

function idbMetaKey(): string {
  return `${STATE_KEY}:meta`;
}

function idbChunkKeyPrefix(): string {
  return `${STATE_KEY}:snapshot:`;
}

function idbChunkKey(generation: string, index: number): string {
  return `${idbChunkKeyPrefix()}${generation}:${index}`;
}

function chunkText(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > IDB_SNAPSHOT_CHUNK_BYTES) {
      pushChunk(chunks, current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    pushChunk(chunks, current);
  }
  return chunks;
}

function pushChunk(chunks: string[], chunk: string): void {
  if (chunks.length >= IDB_SNAPSHOT_MAX_CHUNKS) {
    throw new Error("Matrix IndexedDB snapshot exceeds SQLite chunk limit");
  }
  chunks.push(chunk);
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isIdbSnapshotMeta(value: unknown): value is MatrixIdbSnapshotMeta {
  return (
    isRecord(value) &&
    value.kind === "meta" &&
    value.version === 1 &&
    typeof value.generation === "string" &&
    value.generation.trim() !== "" &&
    typeof value.chunkCount === "number" &&
    Number.isSafeInteger(value.chunkCount) &&
    value.chunkCount >= 0 &&
    value.chunkCount <= IDB_SNAPSHOT_MAX_CHUNKS &&
    typeof value.digest === "string" &&
    typeof value.databaseCount === "number" &&
    Number.isSafeInteger(value.databaseCount) &&
    value.databaseCount >= 0 &&
    typeof value.persistedAt === "string"
  );
}

function isIdbSnapshotChunk(value: unknown): value is MatrixIdbSnapshotChunk {
  return (
    isRecord(value) &&
    value.kind === "snapshot-chunk" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.data === "string"
  );
}
