// Telegram plugin module implements bot info cache behavior.
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeTelegramBotInfo, type TelegramBotInfo } from "./bot-info.js";
import { getTelegramRuntime } from "./runtime.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const LEGACY_STORE_VERSION = 1;
export const TELEGRAM_BOT_INFO_CACHE_NAMESPACE = "telegram.bot-info-cache";
export const TELEGRAM_BOT_INFO_CACHE_MAX_ENTRIES = 128;
export const TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type TelegramBotInfoCacheState = {
  tokenFingerprint: string;
  fetchedAt: string;
  botInfo: TelegramBotInfo;
};

export type CachedTelegramBotInfo = {
  botInfo: TelegramBotInfo;
  fetchedAt: string;
};

type TelegramBotInfoCacheStore = {
  register(key: string, value: TelegramBotInfoCacheState): Promise<void>;
  lookup(key: string): Promise<TelegramBotInfoCacheState | undefined>;
  delete(key: string): Promise<boolean>;
};

let botInfoCacheStoreForTest: TelegramBotInfoCacheStore | undefined;

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function fingerprintFromToken(botToken?: string): string | null {
  const trimmed = botToken?.trim();
  if (!trimmed) {
    return null;
  }
  return fingerprintTelegramBotToken(trimmed);
}

export function resolveTelegramBotInfoCachePath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "telegram", `bot-info-${normalizeAccountId(accountId)}.json`);
}

function openBotInfoCacheStore(): TelegramBotInfoCacheStore {
  return (
    botInfoCacheStoreForTest ??
    getTelegramRuntime().state.openKeyedStore<TelegramBotInfoCacheState>({
      namespace: TELEGRAM_BOT_INFO_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_BOT_INFO_CACHE_MAX_ENTRIES,
      defaultTtlMs: TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS,
    })
  );
}

function parseCachedTelegramBotInfo(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as Partial<TelegramBotInfoCacheState>;
  if (
    typeof state.tokenFingerprint !== "string" ||
    typeof state.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(state.fetchedAt))
  ) {
    return null;
  }
  const botInfo = normalizeTelegramBotInfo(state.botInfo);
  if (!botInfo) {
    return null;
  }
  return {
    tokenFingerprint: state.tokenFingerprint,
    fetchedAt: state.fetchedAt,
    botInfo,
  };
}

function parseLegacyCachedTelegramBotInfo(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as { version?: unknown };
  if (state.version !== LEGACY_STORE_VERSION) {
    return null;
  }
  return parseCachedTelegramBotInfo(value);
}

export async function readCachedTelegramBotInfo(params: {
  accountId?: string;
  botToken?: string;
  now?: Date;
}): Promise<CachedTelegramBotInfo | null> {
  const tokenFingerprint = fingerprintFromToken(params.botToken);
  if (!tokenFingerprint) {
    return null;
  }
  const parsed = parseCachedTelegramBotInfo(
    await openBotInfoCacheStore().lookup(normalizeAccountId(params.accountId)),
  );
  if (!parsed || parsed.tokenFingerprint !== tokenFingerprint) {
    return null;
  }
  const fetchedAtMs = Date.parse(parsed.fetchedAt);
  const nowMs = params.now?.getTime() ?? Date.now();
  if (nowMs - fetchedAtMs > TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS) {
    return null;
  }
  return { botInfo: parsed.botInfo, fetchedAt: parsed.fetchedAt };
}

export async function writeCachedTelegramBotInfo(params: {
  accountId?: string;
  botToken: string;
  botInfo: TelegramBotInfo;
}): Promise<void> {
  const tokenFingerprint = fingerprintFromToken(params.botToken);
  if (!tokenFingerprint) {
    return;
  }
  const botInfo = normalizeTelegramBotInfo(params.botInfo);
  if (!botInfo) {
    return;
  }
  await openBotInfoCacheStore().register(normalizeAccountId(params.accountId), {
    tokenFingerprint,
    fetchedAt: new Date().toISOString(),
    botInfo,
  });
}

export async function deleteCachedTelegramBotInfo(params: { accountId?: string }): Promise<void> {
  await openBotInfoCacheStore().delete(normalizeAccountId(params.accountId));
}

export function setTelegramBotInfoCacheStoreForTest(
  store: TelegramBotInfoCacheStore | undefined,
): void {
  botInfoCacheStoreForTest = store;
}

export async function listTelegramLegacyBotInfoCacheEntries(params: {
  accountId?: string;
  persistedPath: string;
}): Promise<Array<{ key: string; value: TelegramBotInfoCacheState }>> {
  const { value } = await readJsonFileWithFallback<unknown>(params.persistedPath, null);
  const parsed = parseLegacyCachedTelegramBotInfo(value);
  if (!parsed) {
    return [];
  }
  return [{ key: normalizeAccountId(params.accountId), value: parsed }];
}
