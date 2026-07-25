// Memory Wiki plugin module serializes vault mutation transactions.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

type ActiveVaultMutation = { active: boolean };

const activeVaultMutations = new AsyncLocalStorage<ReadonlyMap<string, ActiveVaultMutation>>();
const vaultMutationQueue = new KeyedAsyncQueue();
const MAX_CACHED_VAULT_KEYS = 256;
const canonicalVaultKeys = new Map<string, Promise<string>>();

function normalizeCanonicalVaultKey(vaultPath: string): string {
  return process.platform === "win32" ? vaultPath.toLowerCase() : vaultPath;
}

async function resolveCanonicalVaultKey(resolvedPath: string): Promise<string> {
  const suffix: string[] = [];
  let candidate = resolvedPath;
  while (true) {
    try {
      const existingPath = await fs.realpath(candidate);
      return normalizeCanonicalVaultKey(path.join(existingPath, ...suffix));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(candidate);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) {
        return normalizeCanonicalVaultKey(resolvedPath);
      }
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function resolveMemoryWikiVaultMutationKey(vaultPath: string): Promise<string> {
  const resolvedPath = path.resolve(vaultPath);
  const cached = canonicalVaultKeys.get(resolvedPath);
  if (cached) {
    return await cached;
  }

  // Vault config is process-stable. Resolve physical aliases once, then keep
  // the cache bounded so request-time mutations never freshness-poll paths.
  const canonical = resolveCanonicalVaultKey(resolvedPath);
  if (canonicalVaultKeys.size >= MAX_CACHED_VAULT_KEYS) {
    const oldest = canonicalVaultKeys.keys().next().value;
    if (oldest) {
      canonicalVaultKeys.delete(oldest);
    }
  }
  canonicalVaultKeys.set(resolvedPath, canonical);
  return await canonical;
}

/**
 * Keep coordinated vault read-modify-write transactions isolated from concurrent work in this process.
 * Nested compile calls re-enter; different agent vaults remain parallel.
 */
export async function withMemoryWikiVaultMutation<T>(
  vaultPath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const key = await resolveMemoryWikiVaultMutationKey(vaultPath);
  const active = activeVaultMutations.getStore();
  if (active?.get(key)?.active) {
    return await mutation();
  }

  const lease = { active: true };
  const nextActive = new Map(active ?? []);
  nextActive.set(key, lease);
  return await vaultMutationQueue.enqueue(key, async () => {
    try {
      return await activeVaultMutations.run(nextActive, mutation);
    } finally {
      // Detached children inherit this object. Mark it inactive when the
      // owner exits so later work queues instead of bypassing serialization.
      lease.active = false;
    }
  });
}
