// Metadata contract shared by Doctor migrations and client storage selection.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixSqliteStateEnv } from "../sqlite-state.js";

const STORAGE_META_NAMESPACE = "storage-meta";
export const STORAGE_META_STATE_KEY = "current";
const STORAGE_META_MAX_ENTRIES = 10;

export type MatrixStorageMetadata = {
  homeserver?: string;
  userId?: string;
  accountId?: string;
  accessTokenHash?: string;
  deviceId?: string | null;
  currentTokenStateClaimed?: boolean;
  createdAt?: string;
};

export function openMatrixStorageMetaStoreOptions(storageRootDir: string) {
  return {
    namespace: STORAGE_META_NAMESPACE,
    maxEntries: STORAGE_META_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

export function normalizeMatrixStorageMetadata(value: unknown): MatrixStorageMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata: MatrixStorageMetadata = {};
  if (typeof value.homeserver === "string" && value.homeserver.trim()) {
    metadata.homeserver = value.homeserver.trim();
  }
  if (typeof value.userId === "string" && value.userId.trim()) {
    metadata.userId = value.userId.trim();
  }
  if (typeof value.accountId === "string" && value.accountId.trim()) {
    metadata.accountId = value.accountId.trim();
  }
  if (typeof value.accessTokenHash === "string" && value.accessTokenHash.trim()) {
    metadata.accessTokenHash = value.accessTokenHash.trim();
  }
  if (typeof value.deviceId === "string" && value.deviceId.trim()) {
    metadata.deviceId = value.deviceId.trim();
  }
  if (value.currentTokenStateClaimed === true) {
    metadata.currentTokenStateClaimed = true;
  }
  if (typeof value.createdAt === "string" && value.createdAt.trim()) {
    metadata.createdAt = value.createdAt.trim();
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export async function hasMatrixStorageMetaStateInStore(params: {
  store: Pick<PluginStateKeyedStore<MatrixStorageMetadata>, "lookup">;
}): Promise<boolean> {
  return normalizeMatrixStorageMetadata(await params.store.lookup(STORAGE_META_STATE_KEY)) !== null;
}

export async function writeMatrixStorageMetaStateToStore(params: {
  payload: MatrixStorageMetadata;
  store: Pick<PluginStateKeyedStore<MatrixStorageMetadata>, "register">;
}): Promise<void> {
  await params.store.register(STORAGE_META_STATE_KEY, params.payload);
}
