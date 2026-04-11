import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { ChannelId, ChannelPairingAdapter } from "../channels/plugins/types.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { withFileLock as withPathLock } from "../infra/file-lock.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_PENDING_MAX = 3;
const PAIRING_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;
type AllowFromReadCacheEntry = {
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  entries: string[];
};
type AllowFromStatLike = { mtimeMs: number; size: number } | null;

const allowFromReadCache = new Map<string, AllowFromReadCacheEntry>();

export type PairingChannel = ChannelId;

export type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};

type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

/** Sanitize channel ID for use in filenames (prevent path traversal). */
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

function resolvePairingPath(channel: PairingChannel, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
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

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  return resolveAllowFromPath(channel, env, accountId);
}

async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  return await readJsonFileWithFallback(filePath, fallback);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeJsonFileAtomically(filePath, value);
}

async function readPairingRequests(filePath: string): Promise<PairingRequest[]> {
  const { value } = await readJsonFile<PairingStore>(filePath, {
    version: 1,
    requests: [],
  });
  return Array.isArray(value.requests) ? value.requests : [];
}

async function readPrunedPairingRequests(filePath: string): Promise<{
  requests: PairingRequest[];
  removed: boolean;
}> {
  return pruneExpiredRequests(await readPairingRequests(filePath), Date.now());
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  return await withPathLock(filePath, PAIRING_STORE_LOCK_OPTIONS, async () => {
    return await fn();
  });
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) {
    return true;
  }
  return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}

function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const kept: PairingRequest[] = [];
  let removed = false;
  for (const req of reqs) {
    if (isExpired(req, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(req);
  }
  return { requests: kept, removed };
}

function resolveLastSeenAt(entry: PairingRequest): number {
  return parseTimestamp(entry.lastSeenAt) ?? parseTimestamp(entry.createdAt) ?? 0;
}

function resolvePairingRequestAccountId(entry: PairingRequest): string {
  return normalizePairingAccountId(entry.meta?.accountId) || DEFAULT_ACCOUNT_ID;
}

function pruneExcessRequestsByAccount(reqs: PairingRequest[], maxPending: number) {
  if (maxPending <= 0 || reqs.length <= maxPending) {
    return { requests: reqs, removed: false };
  }
  const grouped = new Map<string, number[]>();
  for (const [index, entry] of reqs.entries()) {
    const accountId = resolvePairingRequestAccountId(entry);
    const current = grouped.get(accountId);
    if (current) {
      current.push(index);
      continue;
    }
    grouped.set(accountId, [index]);
  }

  const droppedIndexes = new Set<number>();
  for (const indexes of grouped.values()) {
    if (indexes.length <= maxPending) {
      continue;
    }
    const sortedIndexes = indexes
      .slice()
      .toSorted((left, right) => resolveLastSeenAt(reqs[left]) - resolveLastSeenAt(reqs[right]));
    for (const index of sortedIndexes.slice(0, sortedIndexes.length - maxPending)) {
      droppedIndexes.add(index);
    }
  }
  if (droppedIndexes.size === 0) {
    return { requests: reqs, removed: false };
  }
  return {
    requests: reqs.filter((_, index) => !droppedIndexes.has(index)),
    removed: true,
  };
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("failed to generate unique pairing code");
}

function normalizePairingAccountId(accountId?: string): string {
  return normalizeLowercaseStringOrEmpty(accountId);
}

function requestMatchesAccountId(entry: PairingRequest, normalizedAccountId: string): boolean {
  if (!normalizedAccountId) {
    return true;
  }
  return resolvePairingRequestAccountId(entry) === normalizedAccountId;
}

function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean {
  // Keep backward compatibility for legacy channel-scoped allowFrom only on default account.
  // Non-default accounts should remain isolated to avoid cross-account implicit approvals.
  return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}

function resolveAllowFromAccountId(accountId?: string): string {
  return normalizePairingAccountId(accountId) || DEFAULT_ACCOUNT_ID;
}

function normalizeId(value: string | number): string {
  return normalizeStringifiedOptionalString(value) ?? "";
}

function normalizeAllowEntry(channel: PairingChannel, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "";
  }
  const adapter = getPairingAdapter(channel);
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  return normalizeOptionalString(normalized) ?? "";
}

function normalizeAllowFromList(channel: PairingChannel, store: AllowFromStore): string[] {
  const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
  return dedupePreserveOrder(list.map((v) => normalizeAllowEntry(channel, v)).filter(Boolean));
}

function normalizeAllowFromInput(channel: PairingChannel, entry: string | number): string {
  return normalizeAllowEntry(channel, normalizeId(entry));
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

async function readAllowFromStateForPath(
  channel: PairingChannel,
  filePath: string,
): Promise<string[]> {
  return (await readAllowFromStateForPathWithExists(channel, filePath)).entries;
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

async function readAllowFromStateForPathWithExists(
  channel: PairingChannel,
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

  const { value, exists } = await readJsonFile<AllowFromStore>(filePath, {
    version: 1,
    allowFrom: [],
  });
  const entries = normalizeAllowFromList(channel, value);
  // stat is guaranteed non-null here: resolveAllowFromReadCacheOrMissing returns early when stat is null.
  setAllowFromReadCache(filePath, {
    exists,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    entries,
  });
  return { entries, exists };
}

function readAllowFromStateForPathSync(channel: PairingChannel, filePath: string): string[] {
  return readAllowFromStateForPathSyncWithExists(channel, filePath).entries;
}

function readAllowFromStateForPathSyncWithExists(
  channel: PairingChannel,
  filePath: string,
): { entries: string[]; exists: boolean } {
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
  // stat is guaranteed non-null here: resolveAllowFromReadCacheOrMissing returns early when stat is null.
  try {
    const parsed = JSON.parse(raw) as AllowFromStore;
    const entries = normalizeAllowFromList(channel, parsed);
    setAllowFromReadCache(filePath, {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries,
    });
    return { entries, exists: true };
  } catch {
    // Keep parity with async reads: malformed JSON still means the file exists.
    setAllowFromReadCache(filePath, {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries: [],
    });
    return { entries: [], exists: true };
  }
}

async function readAllowFromState(params: {
  channel: PairingChannel;
  entry: string | number;
  filePath: string;
}): Promise<{ current: string[]; normalized: string | null }> {
  const { value } = await readJsonFile<AllowFromStore>(params.filePath, {
    version: 1,
    allowFrom: [],
  });
  const current = normalizeAllowFromList(params.channel, value);
  const normalized = normalizeAllowFromInput(params.channel, params.entry);
  return { current, normalized: normalized || null };
}

async function writeAllowFromState(filePath: string, allowFrom: string[]): Promise<void> {
  await writeJsonFile(filePath, {
    version: 1,
    allowFrom,
  } satisfies AllowFromStore);
  let stat: Awaited<ReturnType<typeof fs.promises.stat>> | null = null;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {}
  setAllowFromReadCache(filePath, {
    exists: true,
    mtimeMs: stat?.mtimeMs ?? null,
    size: stat?.size ?? null,
    entries: allowFrom.slice(),
  });
}

async function readNonDefaultAccountAllowFrom(params: {
  channel: PairingChannel;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): Promise<string[]> {
  const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
  return await readAllowFromStateForPath(params.channel, scopedPath);
}

function readNonDefaultAccountAllowFromSync(params: {
  channel: PairingChannel;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): string[] {
  const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
  return readAllowFromStateForPathSync(params.channel, scopedPath);
}

async function updateAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  apply: (current: string[], normalized: string) => string[] | null;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const filePath = resolveAllowFromPath(params.channel, env, params.accountId);
  return await withFileLock(
    filePath,
    { version: 1, allowFrom: [] } satisfies AllowFromStore,
    async () => {
      const { current, normalized } = await readAllowFromState({
        channel: params.channel,
        entry: params.entry,
        filePath,
      });
      if (!normalized) {
        return { changed: false, allowFrom: current };
      }
      const next = params.apply(current, normalized);
      if (!next) {
        return { changed: false, allowFrom: current };
      }
      await writeAllowFromState(filePath, next);
      return { changed: true, allowFrom: next };
    },
  );
}

export async function readLegacyChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const filePath = resolveAllowFromPath(channel, env);
  return await readAllowFromStateForPath(channel, filePath);
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);

  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return await readNonDefaultAccountAllowFrom({
      channel,
      env,
      accountId: resolvedAccountId,
    });
  }
  const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
  const scopedEntries = await readAllowFromStateForPath(channel, scopedPath);
  // Backward compatibility: legacy channel-level allowFrom store was unscoped.
  // Keep honoring it for default account to prevent re-pair prompts after upgrades.
  const legacyPath = resolveAllowFromPath(channel, env);
  const legacyEntries = await readAllowFromStateForPath(channel, legacyPath);
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function readLegacyChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const filePath = resolveAllowFromPath(channel, env);
  return readAllowFromStateForPathSync(channel, filePath);
}

export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);

  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return readNonDefaultAccountAllowFromSync({
      channel,
      env,
      accountId: resolvedAccountId,
    });
  }
  const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
  const scopedEntries = readAllowFromStateForPathSync(channel, scopedPath);
  const legacyPath = resolveAllowFromPath(channel, env);
  const legacyEntries = readAllowFromStateForPathSync(channel, legacyPath);
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function clearPairingAllowFromReadCacheForTest(): void {
  allowFromReadCache.clear();
}

type AllowFromStoreEntryUpdateParams = {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
};

type ChannelAllowFromStoreEntryMutation = (
  current: string[],
  normalized: string,
) => string[] | null;

async function updateChannelAllowFromStore(
  params: {
    apply: ChannelAllowFromStoreEntryMutation;
  } & AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await updateAllowFromStoreEntry({
    channel: params.channel,
    entry: params.entry,
    accountId: params.accountId,
    env: params.env,
    apply: params.apply,
  });
}

async function mutateChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
  apply: ChannelAllowFromStoreEntryMutation,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await updateChannelAllowFromStore({
    ...params,
    apply,
  });
}

export async function addChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
    if (current.includes(normalized)) {
      return null;
    }
    return [...current, normalized];
  });
}

export async function removeChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
    const next = current.filter((entry) => entry !== normalized);
    if (next.length === current.length) {
      return null;
    }
    return next;
  });
}

export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<PairingRequest[]> {
  const filePath = resolvePairingPath(channel, env);
  return await withFileLock(
    filePath,
    { version: 1, requests: [] } satisfies PairingStore,
    async () => {
      const { requests: prunedExpired, removed: expiredRemoved } =
        await readPrunedPairingRequests(filePath);
      const { requests: pruned, removed: cappedRemoved } = pruneExcessRequestsByAccount(
        prunedExpired,
        PAIRING_PENDING_MAX,
      );
      if (expiredRemoved || cappedRemoved) {
        await writeJsonFile(filePath, {
          version: 1,
          requests: pruned,
        } satisfies PairingStore);
      }
      const normalizedAccountId = normalizePairingAccountId(accountId);
      const filtered = normalizedAccountId
        ? pruned.filter((entry) => requestMatchesAccountId(entry, normalizedAccountId))
        : pruned;
      return filtered
        .filter(
          (r) =>
            r &&
            typeof r.id === "string" &&
            typeof r.code === "string" &&
            typeof r.createdAt === "string",
        )
        .slice()
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  );
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  const filePath = resolvePairingPath(params.channel, env);
  return await withFileLock(
    filePath,
    { version: 1, requests: [] } satisfies PairingStore,
    async () => {
      const now = new Date().toISOString();
      const nowMs = Date.now();
      const id = normalizeId(params.id);
      const normalizedAccountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
      const baseMeta =
        params.meta && typeof params.meta === "object"
          ? Object.fromEntries(
              Object.entries(params.meta)
                .map(([k, v]) => [k, normalizeOptionalString(v) ?? ""] as const)
                .filter(([_, v]) => Boolean(v)),
            )
          : undefined;
      const meta = { ...baseMeta, accountId: normalizedAccountId };

      let reqs = await readPairingRequests(filePath);
      const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(
        reqs,
        nowMs,
      );
      reqs = prunedExpired;
      const normalizedMatchingAccountId = normalizedAccountId;
      const existingIdx = reqs.findIndex((r) => {
        if (r.id !== id) {
          return false;
        }
        return requestMatchesAccountId(r, normalizedMatchingAccountId);
      });
      const existingCodes = new Set(
        reqs.map((req) => (normalizeOptionalString(req.code) ?? "").toUpperCase()),
      );

      if (existingIdx >= 0) {
        const existing = reqs[existingIdx];
        const existingCode = normalizeOptionalString(existing?.code) ?? "";
        const code = existingCode || generateUniqueCode(existingCodes);
        const next: PairingRequest = {
          id,
          code,
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
          meta: meta ?? existing?.meta,
        };
        reqs[existingIdx] = next;
        const { requests: capped } = pruneExcessRequestsByAccount(reqs, PAIRING_PENDING_MAX);
        await writeJsonFile(filePath, {
          version: 1,
          requests: capped,
        } satisfies PairingStore);
        return { code, created: false };
      }

      const { requests: capped, removed: cappedRemoved } = pruneExcessRequestsByAccount(
        reqs,
        PAIRING_PENDING_MAX,
      );
      reqs = capped;
      const accountRequestCount = reqs.filter((r) =>
        requestMatchesAccountId(r, normalizedMatchingAccountId),
      ).length;
      if (PAIRING_PENDING_MAX > 0 && accountRequestCount >= PAIRING_PENDING_MAX) {
        if (expiredRemoved || cappedRemoved) {
          await writeJsonFile(filePath, {
            version: 1,
            requests: reqs,
          } satisfies PairingStore);
        }
        return { code: "", created: false };
      }
      const code = generateUniqueCode(existingCodes);
      const next: PairingRequest = {
        id,
        code,
        createdAt: now,
        lastSeenAt: now,
        ...(meta ? { meta } : {}),
      };
      await writeJsonFile(filePath, {
        version: 1,
        requests: [...reqs, next],
      } satisfies PairingStore);
      return { code, created: true };
    },
  );
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry?: PairingRequest } | null> {
  const env = params.env ?? process.env;
  const code = (normalizeNullableString(params.code) ?? "").toUpperCase();
  if (!code) {
    return null;
  }

  const filePath = resolvePairingPath(params.channel, env);
  return await withFileLock(
    filePath,
    { version: 1, requests: [] } satisfies PairingStore,
    async () => {
      const { requests: pruned, removed } = await readPrunedPairingRequests(filePath);
      const normalizedAccountId = normalizePairingAccountId(params.accountId);
      const idx = pruned.findIndex((r) => {
        if (r.code.toUpperCase() !== code) {
          return false;
        }
        return requestMatchesAccountId(r, normalizedAccountId);
      });
      if (idx < 0) {
        if (removed) {
          await writeJsonFile(filePath, {
            version: 1,
            requests: pruned,
          } satisfies PairingStore);
        }
        return null;
      }
      const entry = pruned[idx];
      if (!entry) {
        return null;
      }
      pruned.splice(idx, 1);
      await writeJsonFile(filePath, {
        version: 1,
        requests: pruned,
      } satisfies PairingStore);
      const entryAccountId = normalizeOptionalString(entry.meta?.accountId);
      await addChannelAllowFromStoreEntry({
        channel: params.channel,
        entry: entry.id,
        accountId: normalizeOptionalString(params.accountId) ?? entryAccountId,
        env,
      });
      return { id: entry.id, entry };
    },
  );
}
