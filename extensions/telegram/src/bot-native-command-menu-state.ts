// Owns Telegram command-menu identity, process serialization, and durable locale state.
import type { LanguageCode } from "grammy/types";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOptionalTelegramRuntime } from "./runtime.js";
import {
  fingerprintTelegramBotToken,
  resolveTelegramBotUserIdFromToken,
} from "./token-fingerprint.js";

const TELEGRAM_MENU_LOCALE_LEDGER_VERSION = 1;
const TELEGRAM_MENU_LOCALE_LEDGER_NAMESPACE = "telegram.command-menu-locales";
const TELEGRAM_MENU_LOCALE_LEDGER_MAX_ENTRIES = 1_000;
const TELEGRAM_MENU_LEDGER_DIAGNOSTIC_MAX_CODES = 8;
const TELEGRAM_MENU_LEDGER_DIAGNOSTIC_CODE_MAX_LENGTH = 32;
const TELEGRAM_MENU_LANGUAGE_CODES: ReadonlySet<string> = new Set<LanguageCode>([
  "ab",
  "aa",
  "af",
  "ak",
  "sq",
  "am",
  "ar",
  "an",
  "hy",
  "as",
  "av",
  "ae",
  "ay",
  "az",
  "bm",
  "ba",
  "eu",
  "be",
  "bn",
  "bi",
  "bs",
  "br",
  "bg",
  "my",
  "ca",
  "ch",
  "ce",
  "ny",
  "zh",
  "cu",
  "cv",
  "kw",
  "co",
  "cr",
  "hr",
  "cs",
  "da",
  "dv",
  "nl",
  "dz",
  "en",
  "eo",
  "et",
  "ee",
  "fo",
  "fj",
  "fi",
  "fr",
  "fy",
  "ff",
  "gd",
  "gl",
  "lg",
  "ka",
  "de",
  "el",
  "kl",
  "gn",
  "gu",
  "ht",
  "ha",
  "he",
  "hz",
  "hi",
  "ho",
  "hu",
  "is",
  "io",
  "ig",
  "id",
  "ia",
  "ie",
  "iu",
  "ik",
  "ga",
  "it",
  "ja",
  "jv",
  "kn",
  "kr",
  "ks",
  "kk",
  "km",
  "ki",
  "rw",
  "ky",
  "kv",
  "kg",
  "ko",
  "kj",
  "ku",
  "lo",
  "la",
  "lv",
  "li",
  "ln",
  "lt",
  "lu",
  "lb",
  "mk",
  "mg",
  "ms",
  "ml",
  "mt",
  "gv",
  "mi",
  "mr",
  "mh",
  "mn",
  "na",
  "nv",
  "nd",
  "nr",
  "ng",
  "ne",
  "no",
  "nb",
  "nn",
  "ii",
  "oc",
  "oj",
  "or",
  "om",
  "os",
  "pi",
  "ps",
  "fa",
  "pl",
  "pt",
  "pa",
  "qu",
  "ro",
  "rm",
  "rn",
  "ru",
  "se",
  "sm",
  "sg",
  "sa",
  "sc",
  "sr",
  "sn",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "st",
  "es",
  "su",
  "sw",
  "ss",
  "sv",
  "tl",
  "ty",
  "tg",
  "ta",
  "tt",
  "te",
  "th",
  "bo",
  "ti",
  "to",
  "ts",
  "tn",
  "tr",
  "tk",
  "tw",
  "ug",
  "uk",
  "ur",
  "uz",
  "ve",
  "vi",
  "vo",
  "wa",
  "cy",
  "wo",
  "xh",
  "yi",
  "yo",
  "za",
  "zu",
]);

type TelegramMenuLocaleLedger = {
  version: typeof TELEGRAM_MENU_LOCALE_LEDGER_VERSION;
  languageCodes: LanguageCode[];
};

type TelegramMenuLocaleLedgerHandle = {
  store: PluginStateKeyedStore<unknown>;
  value?: TelegramMenuLocaleLedger;
};

type TelegramMenuLocaleLedgerNormalization = {
  value?: TelegramMenuLocaleLedger;
  isCanonical: boolean;
  unsupportedLanguageCodes: string[];
  malformedEntryCount: number;
};

const syncTails = new Map<string, Promise<void>>();
// Successful command hashes stay process-local so restarts always republish.
const syncedCommandHashes = new Map<string, string>();
const knownLanguageCodes = new Map<string, Set<LanguageCode>>();

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

export function getProcessKnownTelegramMenuLocales(ownerKey: string): Set<LanguageCode> {
  let locales = knownLanguageCodes.get(ownerKey);
  if (!locales) {
    locales = new Set<LanguageCode>();
    knownLanguageCodes.set(ownerKey, locales);
  }
  return locales;
}

function isTelegramMenuLanguageCode(languageCode: string): languageCode is LanguageCode {
  return TELEGRAM_MENU_LANGUAGE_CODES.has(languageCode);
}

export function normalizeTelegramMenuLanguageCode(languageCode: string): LanguageCode | null {
  const normalized = languageCode.trim().toLowerCase();
  return isTelegramMenuLanguageCode(normalized) ? normalized : null;
}

function formatTelegramMenuLedgerUnsupportedCode(languageCode: string): string {
  const readable = languageCode.trim().replace(/\s+/g, " ") || "(empty)";
  if (readable.length <= TELEGRAM_MENU_LEDGER_DIAGNOSTIC_CODE_MAX_LENGTH) {
    return readable;
  }
  return `${readable.slice(0, TELEGRAM_MENU_LEDGER_DIAGNOSTIC_CODE_MAX_LENGTH - 3)}...`;
}

function normalizeTelegramMenuLocaleLedger(stored: unknown): TelegramMenuLocaleLedgerNormalization {
  const candidate = isRecord(stored) ? stored : undefined;
  const rawLanguageCodes = Array.isArray(candidate?.languageCodes) ? candidate.languageCodes : [];
  const languageCodes = new Set<LanguageCode>();
  const unsupportedLanguageCodes = new Set<string>();
  let malformedEntryCount = 0;
  for (const rawLanguageCode of rawLanguageCodes) {
    if (typeof rawLanguageCode !== "string") {
      malformedEntryCount += 1;
      continue;
    }
    const languageCode = normalizeTelegramMenuLanguageCode(rawLanguageCode);
    if (languageCode) {
      languageCodes.add(languageCode);
    } else {
      unsupportedLanguageCodes.add(formatTelegramMenuLedgerUnsupportedCode(rawLanguageCode));
    }
  }

  if (!candidate || candidate.version !== TELEGRAM_MENU_LOCALE_LEDGER_VERSION) {
    malformedEntryCount += 1;
  }
  if (!Array.isArray(candidate?.languageCodes)) {
    malformedEntryCount += 1;
  }
  if (candidate && Object.keys(candidate).toSorted().join(",") !== "languageCodes,version") {
    malformedEntryCount += 1;
  }

  const canonicalLanguageCodes = [...languageCodes].toSorted();
  const isCanonical =
    canonicalLanguageCodes.length > 0 &&
    malformedEntryCount === 0 &&
    unsupportedLanguageCodes.size === 0 &&
    rawLanguageCodes.length === canonicalLanguageCodes.length &&
    rawLanguageCodes.every((languageCode, index) => languageCode === canonicalLanguageCodes[index]);
  return {
    ...(canonicalLanguageCodes.length > 0
      ? {
          value: {
            version: TELEGRAM_MENU_LOCALE_LEDGER_VERSION,
            languageCodes: canonicalLanguageCodes,
          },
        }
      : {}),
    isCanonical,
    unsupportedLanguageCodes: [...unsupportedLanguageCodes].toSorted(),
    malformedEntryCount,
  };
}

function formatTelegramMenuLocaleLedgerRepairDiagnostic(params: {
  botId: string;
  normalization: TelegramMenuLocaleLedgerNormalization;
}): string {
  const action = params.normalization.value ? "repaired" : "reset";
  const details: string[] = [];
  const unsupportedCodes = params.normalization.unsupportedLanguageCodes;
  if (unsupportedCodes.length > 0) {
    const visibleCodes = unsupportedCodes.slice(0, TELEGRAM_MENU_LEDGER_DIAGNOSTIC_MAX_CODES);
    const hiddenCount = unsupportedCodes.length - visibleCodes.length;
    details.push(
      `discarded unsupported language codes: ${visibleCodes.join(", ")}${hiddenCount > 0 ? ` (+${hiddenCount} more)` : ""}`,
    );
  }
  if (params.normalization.malformedEntryCount > 0) {
    details.push(
      `discarded ${params.normalization.malformedEntryCount} malformed ledger field(s) or entry(ies)`,
    );
  }
  const detail = details.length > 0 ? ` (${details.join("; ")})` : "";
  return `Telegram command menu locale ledger for bot ${params.botId} was ${action}; the unshipped ledger contained non-canonical data${detail}.`;
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
    const store = telegramRuntime.state.openKeyedStore<unknown>({
      namespace: TELEGRAM_MENU_LOCALE_LEDGER_NAMESPACE,
      maxEntries: TELEGRAM_MENU_LOCALE_LEDGER_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const stored = await store.lookup(params.botId);
    if (stored === undefined) {
      return { store };
    }
    const normalization = normalizeTelegramMenuLocaleLedger(stored);
    if (normalization.isCanonical) {
      return { store, value: normalization.value };
    }
    try {
      if (normalization.value) {
        await store.register(params.botId, normalization.value);
      } else {
        await store.delete(params.botId);
      }
    } catch (error) {
      params.runtime.error?.(
        `Telegram command menu locale ledger repair failed for bot ${params.botId}: ${String(error)}`,
      );
      return null;
    }
    params.runtime.error?.(
      formatTelegramMenuLocaleLedgerRepairDiagnostic({
        botId: params.botId,
        normalization,
      }),
    );
    return { store, ...(normalization.value ? { value: normalization.value } : {}) };
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
  languageCodes: LanguageCode[];
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
