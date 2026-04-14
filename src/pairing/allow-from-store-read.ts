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

type AllowFromStore = {
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

const allowFromReadCache = new Map<string, AllowFromReadCacheEntry>();

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

function safeChannelKey(channel: PairingChannel): string {
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

function resolveAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const normalizedAccountId = normalizeOptionalString(accountId) ?? "";
  if (!normalizedAccountId) {
    return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(
    resolveCredentialsDir(env),
    `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`,
  );
}

function dedupePreserveOrder(entries: string[]): string[] {
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

function normalizeRawAllowFromList(store: AllowFromStore): string[] {
  const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
  return dedupePreserveOrder(
    list.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean),
  );
}

function cloneAllowFromCacheEntry(entry: AllowFromReadCacheEntry): AllowFromReadCacheEntry {
  return {
    exists: entry.exists,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    entries: entry.entries.slice(),
  };
}

function setAllowFromReadCache(filePath: string, entry: AllowFromReadCacheEntry): void {
  allowFromReadCache.set(filePath, cloneAllowFromCacheEntry(entry));
}

function resolveAllowFromReadCacheHit(params: {
  filePath: string;
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
}): AllowFromReadCacheEntry | null {
  const cached = allowFromReadCache.get(params.filePath);
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

function resolveAllowFromReadCacheOrMissing(
  filePath: string,
  stat: AllowFromStatLike,
): { entries: string[]; exists: boolean } | null {
  const cached = resolveAllowFromReadCacheHit({
    filePath,
    exists: Boolean(stat),
    mtimeMs: stat?.mtimeMs ?? null,
    size: stat?.size ?? null,
  });
  if (cached) {
    return { entries: cached.entries, exists: cached.exists };
  }
  if (!stat) {
    setAllowFromReadCache(filePath, {
      exists: false,
      mtimeMs: null,
      size: null,
      entries: [],
    });
    return { entries: [], exists: false };
  }
  return null;
}

async function readAllowFromEntriesForPathWithExists(
  filePath: string,
): Promise<{ entries: string[]; exists: boolean }> {
  let stat: Awaited<ReturnType<typeof fs.promises.stat>> | null = null;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  const cachedOrMissing = resolveAllowFromReadCacheOrMissing(filePath, stat);
  if (cachedOrMissing) {
    return cachedOrMissing;
  }
  if (!stat) {
    return { entries: [], exists: false };
  }

  const { value, exists } = await readJsonFileWithFallback<AllowFromStore>(filePath, {
    version: 1,
    allowFrom: [],
  });
  const entries = normalizeRawAllowFromList(value);
  setAllowFromReadCache(filePath, {
    exists,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    entries,
  });
  return { entries, exists };
}

function readAllowFromEntriesForPathSyncWithExists(filePath: string): {
  entries: string[];
  exists: boolean;
} {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      return { entries: [], exists: false };
    }
  }

  const cachedOrMissing = resolveAllowFromReadCacheOrMissing(filePath, stat);
  if (cachedOrMissing) {
    return cachedOrMissing;
  }
  if (!stat) {
    return { entries: [], exists: false };
  }

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { entries: [], exists: false };
    }
    return { entries: [], exists: false };
  }

  try {
    const parsed = JSON.parse(raw) as AllowFromStore;
    const entries = normalizeRawAllowFromList(parsed);
    setAllowFromReadCache(filePath, {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries,
    });
    return { entries, exists: true };
  } catch {
    setAllowFromReadCache(filePath, {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries: [],
    });
    return { entries: [], exists: true };
  }
}

function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean {
  return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}

function resolveAllowFromAccountId(accountId?: string): string {
  return normalizeLowercaseStringOrEmpty(accountId) || DEFAULT_ACCOUNT_ID;
}

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  return resolveAllowFromPath(channel, env, accountId);
}

export async function readLegacyChannelAllowFromStoreEntries(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const filePath = resolveAllowFromPath(channel, env);
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
        resolveAllowFromPath(channel, env, resolvedAccountId),
      )
    ).entries;
  }
  const scopedEntries = (
    await readAllowFromEntriesForPathWithExists(
      resolveAllowFromPath(channel, env, resolvedAccountId),
    )
  ).entries;
  const legacyEntries = (
    await readAllowFromEntriesForPathWithExists(resolveAllowFromPath(channel, env))
  ).entries;
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function readLegacyChannelAllowFromStoreEntriesSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return readAllowFromEntriesForPathSyncWithExists(resolveAllowFromPath(channel, env)).entries;
}

export function readChannelAllowFromStoreEntriesSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return readAllowFromEntriesForPathSyncWithExists(
      resolveAllowFromPath(channel, env, resolvedAccountId),
    ).entries;
  }
  const scopedEntries = readAllowFromEntriesForPathSyncWithExists(
    resolveAllowFromPath(channel, env, resolvedAccountId),
  ).entries;
  const legacyEntries = readAllowFromEntriesForPathSyncWithExists(
    resolveAllowFromPath(channel, env),
  ).entries;
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function clearAllowFromStoreReadCacheForTest(): void {
  allowFromReadCache.clear();
}
