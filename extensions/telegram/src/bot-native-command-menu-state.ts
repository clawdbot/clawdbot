// Owns Telegram command-menu identity, process serialization, and durable locale state.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getOptionalTelegramRuntime } from "./runtime.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";
import { resolveTelegramBotUserIdFromToken } from "./token.js";

const TELEGRAM_MENU_LOCALE_LEDGER_VERSION = 1;
const TELEGRAM_MENU_LOCALE_LEDGER_NAMESPACE = "telegram.command-menu-locales";
const TELEGRAM_MENU_LOCALE_LEDGER_MAX_ENTRIES = 1_000;

type TelegramMenuLocaleLedger = {
  version: typeof TELEGRAM_MENU_LOCALE_LEDGER_VERSION;
  languageCodes: string[];
};

type TelegramMenuLocaleLedgerHandle = {
  store: PluginStateKeyedStore<TelegramMenuLocaleLedger>;
  value?: TelegramMenuLocaleLedger;
};

const syncTails = new Map<string, Promise<void>>();
// Successful command hashes stay process-local so restarts always republish.
const syncedCommandHashes = new Map<string, string>();
const knownLanguageCodes = new Map<string, Set<string>>();

export function resolveTelegramMenuRemoteOwner(params: {
  accountId?: string;
  botId?: number;
  botToken?: string;
}) {
  const token = params.botToken?.trim();
  const tokenBotId = resolveTelegramBotUserIdFromToken(token);
  const botId = params.botId ?? tokenBotId;
  const tokenFingerprint = token ? fingerprintTelegramBotToken(token) : undefined;
  const fallbackKey = `${params.accountId ?? "default"}:${tokenFingerprint ?? "unknown"}`;
  const queueKey = botId === undefined ? `fallback:${fallbackKey}` : `bot:${botId}`;
  return {
    queueKey,
    hashKey: `${queueKey}:${tokenFingerprint ?? ""}`,
    ...(botId === undefined ? {} : { botId: String(botId) }),
  };
}

export function enqueueTelegramMenuSync(params: {
  ownerKey: string;
  sync: () => Promise<void>;
  onError: (error: unknown) => void;
}): void {
  const previous = syncTails.get(params.ownerKey) ?? Promise.resolve();
  // A remote bot owns one mutation lane so reload generations cannot interleave.
  const next = previous.then(params.sync).catch((error: unknown) => {
    try {
      params.onError(error);
    } catch {
      // Logging failures must not poison the remote owner's next generation.
    }
  });
  syncTails.set(params.ownerKey, next);
  void next.then(() => {
    if (syncTails.get(params.ownerKey) === next) {
      syncTails.delete(params.ownerKey);
    }
  });
}

export function readTelegramMenuCommandHash(key: string): string | null {
  return syncedCommandHashes.get(key) ?? null;
}

export function writeTelegramMenuCommandHash(key: string, hash: string): void {
  syncedCommandHashes.set(key, hash);
}

export function getProcessKnownTelegramMenuLocales(ownerKey: string): Set<string> {
  let locales = knownLanguageCodes.get(ownerKey);
  if (!locales) {
    locales = new Set<string>();
    knownLanguageCodes.set(ownerKey, locales);
  }
  return locales;
}

export function normalizeTelegramMenuLanguageCode(languageCode: string): string | null {
  const normalized = languageCode.trim().toLowerCase();
  return /^[a-z]{2}$/.test(normalized) ? normalized : null;
}

function parseTelegramMenuLocaleLedger(value: unknown): TelegramMenuLocaleLedger | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { version?: unknown; languageCodes?: unknown };
  if (
    candidate.version !== TELEGRAM_MENU_LOCALE_LEDGER_VERSION ||
    !Array.isArray(candidate.languageCodes)
  ) {
    return null;
  }
  const languageCodes: string[] = [];
  for (const languageCode of candidate.languageCodes) {
    if (
      typeof languageCode !== "string" ||
      normalizeTelegramMenuLanguageCode(languageCode) !== languageCode
    ) {
      return null;
    }
    languageCodes.push(languageCode);
  }
  const sortedLanguageCodes = languageCodes.toSorted();
  if (
    new Set(languageCodes).size !== languageCodes.length ||
    languageCodes.some((languageCode, index) => languageCode !== sortedLanguageCodes[index])
  ) {
    return null;
  }
  return { version: TELEGRAM_MENU_LOCALE_LEDGER_VERSION, languageCodes };
}

export async function readTelegramMenuLocaleLedger(params: {
  botId: string;
  runtime: RuntimeEnv;
}): Promise<TelegramMenuLocaleLedgerHandle | null> {
  const telegramRuntime = getOptionalTelegramRuntime();
  if (!telegramRuntime) {
    params.runtime.error?.(
      `Telegram command menu locale ledger unavailable for bot ${params.botId}: runtime not initialized`,
    );
    return null;
  }
  try {
    const store = telegramRuntime.state.openKeyedStore<TelegramMenuLocaleLedger>({
      namespace: TELEGRAM_MENU_LOCALE_LEDGER_NAMESPACE,
      maxEntries: TELEGRAM_MENU_LOCALE_LEDGER_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const stored = await store.lookup(params.botId);
    if (stored === undefined) {
      return { store };
    }
    const value = parseTelegramMenuLocaleLedger(stored);
    if (!value) {
      params.runtime.error?.(
        `Telegram command menu locale ledger is malformed for bot ${params.botId}; preserving it for recovery.`,
      );
      return null;
    }
    return { store, value };
  } catch (error) {
    params.runtime.error?.(
      `Telegram command menu locale ledger unavailable for bot ${params.botId}: ${String(error)}`,
    );
    return null;
  }
}

export async function persistTelegramMenuLocaleLedger(params: {
  botId: string;
  read: TelegramMenuLocaleLedgerHandle;
  languageCodes: string[];
}): Promise<void> {
  const current = params.read.value?.languageCodes ?? [];
  if (
    current.length === params.languageCodes.length &&
    current.every((languageCode, index) => languageCode === params.languageCodes[index])
  ) {
    return;
  }
  if (params.languageCodes.length === 0) {
    await params.read.store.delete(params.botId);
    return;
  }
  // Record locale intent before publishing so partial writes remain cleanup-visible.
  await params.read.store.register(params.botId, {
    version: TELEGRAM_MENU_LOCALE_LEDGER_VERSION,
    languageCodes: params.languageCodes,
  });
}
