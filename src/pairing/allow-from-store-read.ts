import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  clearAllowFromFileReadCacheForNamespace,
  dedupePreserveOrder,
  readAllowFromFileSyncWithExists,
  readAllowFromFileWithExists,
  resolveAllowFromAccountId,
  resolveAllowFromFilePath,
  shouldIncludeLegacyAllowFromEntries,
  type AllowFromStore,
} from "./allow-from-store-file.js";
import type { PairingChannel } from "./pairing-store.types.js";

const ALLOW_FROM_STORE_READ_CACHE_NAMESPACE = "allow-from-store-read";

function normalizeRawAllowFromList(store: AllowFromStore): string[] {
  const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
  return dedupePreserveOrder(
    list.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean),
  );
}

async function readAllowFromEntriesForPathWithExists(
  filePath: string,
): Promise<{ entries: string[]; exists: boolean }> {
  return await readAllowFromFileWithExists({
    cacheNamespace: ALLOW_FROM_STORE_READ_CACHE_NAMESPACE,
    filePath,
    normalizeStore: normalizeRawAllowFromList,
  });
}

function readAllowFromEntriesForPathSyncWithExists(filePath: string): {
  entries: string[];
  exists: boolean;
} {
  return readAllowFromFileSyncWithExists({
    cacheNamespace: ALLOW_FROM_STORE_READ_CACHE_NAMESPACE,
    filePath,
    normalizeStore: normalizeRawAllowFromList,
  });
}

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  return resolveAllowFromFilePath(channel, env, accountId);
}

export async function readLegacyChannelAllowFromStoreEntries(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const filePath = resolveAllowFromFilePath(channel, env);
  return (await readAllowFromEntriesForPathWithExists(filePath)).entries;
}

export async function readChannelAllowFromStoreEntries(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return (
      await readAllowFromEntriesForPathWithExists(
        resolveAllowFromFilePath(channel, env, resolvedAccountId),
      )
    ).entries;
  }
  const scopedEntries = (
    await readAllowFromEntriesForPathWithExists(
      resolveAllowFromFilePath(channel, env, resolvedAccountId),
    )
  ).entries;
  const legacyEntries = (
    await readAllowFromEntriesForPathWithExists(resolveAllowFromFilePath(channel, env))
  ).entries;
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function readLegacyChannelAllowFromStoreEntriesSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return readAllowFromEntriesForPathSyncWithExists(resolveAllowFromFilePath(channel, env)).entries;
}

export function readChannelAllowFromStoreEntriesSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return readAllowFromEntriesForPathSyncWithExists(
      resolveAllowFromFilePath(channel, env, resolvedAccountId),
    ).entries;
  }
  const scopedEntries = readAllowFromEntriesForPathSyncWithExists(
    resolveAllowFromFilePath(channel, env, resolvedAccountId),
  ).entries;
  const legacyEntries = readAllowFromEntriesForPathSyncWithExists(
    resolveAllowFromFilePath(channel, env),
  ).entries;
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function clearAllowFromStoreReadCacheForTest(): void {
  clearAllowFromFileReadCacheForNamespace(ALLOW_FROM_STORE_READ_CACHE_NAMESPACE);
}
