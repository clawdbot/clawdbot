import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeTelegramBotInfo, type TelegramBotInfo } from "./bot-info.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const STORE_VERSION = 1;
export const TELEGRAM_BOT_INFO_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type TelegramBotInfoCacheState = {
  version: number;
  tokenFingerprint: string;
  fetchedAt: string;
  botInfo: TelegramBotInfo;
};

export type CachedTelegramBotInfo = {
  botInfo: TelegramBotInfo;
  fetchedAt: string;
};

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

function parseCachedTelegramBotInfo(value: unknown): TelegramBotInfoCacheState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const state = value as {
    version?: unknown;
    tokenFingerprint?: unknown;
    fetchedAt?: unknown;
    botInfo?: unknown;
  };
  if (
    state.version !== STORE_VERSION ||
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
    version: STORE_VERSION,
    tokenFingerprint: state.tokenFingerprint,
    fetchedAt: state.fetchedAt,
    botInfo,
  };
}

export async function readCachedTelegramBotInfo(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<CachedTelegramBotInfo | null> {
  const tokenFingerprint = fingerprintFromToken(params.botToken);
  if (!tokenFingerprint) {
    return null;
  }
  const filePath = resolveTelegramBotInfoCachePath(params.accountId, params.env);
  const { value } = await readJsonFileWithFallback<unknown>(filePath, null);
  const parsed = parseCachedTelegramBotInfo(value);
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
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const tokenFingerprint = fingerprintFromToken(params.botToken);
  if (!tokenFingerprint) {
    return;
  }
  const filePath = resolveTelegramBotInfoCachePath(params.accountId, params.env);
  const payload: TelegramBotInfoCacheState = {
    version: STORE_VERSION,
    tokenFingerprint,
    fetchedAt: new Date().toISOString(),
    botInfo: params.botInfo,
  };
  await writeJsonFileAtomically(filePath, payload);
}

export async function deleteCachedTelegramBotInfo(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveTelegramBotInfoCachePath(params.accountId, params.env);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return;
    }
    throw err;
  }
}
