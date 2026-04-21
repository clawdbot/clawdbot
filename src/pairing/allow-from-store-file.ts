import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { readJsonFileWithFallback } from "../plugin-sdk/json-store.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { PairingChannel } from "./pairing-store.types.js";

export type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};

type AllowFromReadCacheEntry = {
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  entries: string[];
};

type AllowFromStatLike = { mtimeMs: number; size: number } | null;

type NormalizeAllowFromStore = (store: AllowFromStore) => string[];

const allowFromReadCache = new Map<string, AllowFromReadCacheEntry>();

export function resolvePairingCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

/** Sanitize channel ID for use in filenames (prevent path traversal). */
export function safeChannelKey(channel: PairingChannel): string {
  const raw = normalizeLowercaseStringOrEmpty(String(channel));
  if (!raw) {
    throw new Error("invalid pairing channel");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing channel");
  }
  return safe;
}

function safeAccountKey(accountId: string): string {
  const raw = normalizeLowercaseStringOrEmpty(accountId);
  if (!raw) {
    throw new Error("invalid pairing account id");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing account id");
  }
  return safe;
}

export function resolveAllowFromFilePath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const normalizedAccountId = normalizeOptionalString(accountId) ?? "";
  if (!normalizedAccountId) {
    return path.join(resolvePairingCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(
    resolvePairingCredentialsDir(env),
    `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`,
  );
}

export function dedupePreserveOrder(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeOptionalString(entry) ?? "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean {
  return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}

export function resolveAllowFromAccountId(accountId?: string): string {
  return normalizeLowercaseStringOrEmpty(accountId) || DEFAULT_ACCOUNT_ID;
}

function cloneAllowFromCacheEntry(entry: AllowFromReadCacheEntry): AllowFromReadCacheEntry {
  return {
    exists: entry.exists,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    entries: entry.entries.slice(),
  };
}

function resolveAllowFromCacheKey(cacheNamespace: string, filePath: string): string {
  return `${cacheNamespace}\u0000${filePath}`;
}

export function setAllowFromFileReadCache(params: {
  cacheNamespace: string;
  filePath: string;
  entry: AllowFromReadCacheEntry;
}): void {
  allowFromReadCache.set(
    resolveAllowFromCacheKey(params.cacheNamespace, params.filePath),
    cloneAllowFromCacheEntry(params.entry),
  );
}

function resolveAllowFromReadCacheHit(params: {
  cacheNamespace: string;
  filePath: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}): AllowFromReadCacheEntry | null {
  const cached = allowFromReadCache.get(
    resolveAllowFromCacheKey(params.cacheNamespace, params.filePath),
  );
  if (!cached) {
    return null;
  }
  if (cached.exists !== params.exists) {
    return null;
  }
  if (!params.exists) {
    return cloneAllowFromCacheEntry(cached);
  }
  if (cached.mtimeMs !== params.mtimeMs || cached.size !== params.size) {
    return null;
  }
  return cloneAllowFromCacheEntry(cached);
}

function resolveAllowFromReadCacheOrMissing(params: {
  cacheNamespace: string;
  filePath: string;
  stat: AllowFromStatLike;
}): { entries: string[]; exists: boolean } | null {
  const cached = resolveAllowFromReadCacheHit({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    exists: Boolean(params.stat),
    mtimeMs: params.stat?.mtimeMs ?? null,
    size: params.stat?.size ?? null,
  });
  if (cached) {
    return { entries: cached.entries, exists: cached.exists };
  }
  if (!params.stat) {
    setAllowFromFileReadCache({
      cacheNamespace: params.cacheNamespace,
      filePath: params.filePath,
      entry: {
        exists: false,
        mtimeMs: null,
        size: null,
        entries: [],
      },
    });
    return { entries: [], exists: false };
  }
  return null;
}

export async function readAllowFromFileWithExists(params: {
  cacheNamespace: string;
  filePath: string;
  normalizeStore: NormalizeAllowFromStore;
}): Promise<{ entries: string[]; exists: boolean }> {
  let stat: Awaited<ReturnType<typeof fs.promises.stat>> | null = null;
  try {
    stat = await fs.promises.stat(params.filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  const cachedOrMissing = resolveAllowFromReadCacheOrMissing({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    stat,
  });
  if (cachedOrMissing) {
    return cachedOrMissing;
  }
  if (!stat) {
    return { entries: [], exists: false };
  }

  const { value, exists } = await readJsonFileWithFallback<AllowFromStore>(params.filePath, {
    version: 1,
    allowFrom: [],
  });
  const entries = params.normalizeStore(value);
  setAllowFromFileReadCache({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    entry: {
      exists,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries,
    },
  });
  return { entries, exists };
}

export function readAllowFromFileSyncWithExists(params: {
  cacheNamespace: string;
  filePath: string;
  normalizeStore: NormalizeAllowFromStore;
}): { entries: string[]; exists: boolean } {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(params.filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      return { entries: [], exists: false };
    }
  }

  const cachedOrMissing = resolveAllowFromReadCacheOrMissing({
    cacheNamespace: params.cacheNamespace,
    filePath: params.filePath,
    stat,
  });
  if (cachedOrMissing) {
    return cachedOrMissing;
  }
  if (!stat) {
    return { entries: [], exists: false };
  }

  let raw = "";
  try {
    raw = fs.readFileSync(params.filePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { entries: [], exists: false };
    }
    return { entries: [], exists: false };
  }

  try {
    const parsed = JSON.parse(raw) as AllowFromStore;
    const entries = params.normalizeStore(parsed);
    setAllowFromFileReadCache({
      cacheNamespace: params.cacheNamespace,
      filePath: params.filePath,
      entry: {
        exists: true,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        entries,
      },
    });
    return { entries, exists: true };
  } catch {
    setAllowFromFileReadCache({
      cacheNamespace: params.cacheNamespace,
      filePath: params.filePath,
      entry: {
        exists: true,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        entries: [],
      },
    });
    return { entries: [], exists: true };
  }
}

export function clearAllowFromFileReadCacheForNamespace(cacheNamespace: string): void {
  for (const key of allowFromReadCache.keys()) {
    if (key.startsWith(`${cacheNamespace}\u0000`)) {
      allowFromReadCache.delete(key);
    }
  }
}
