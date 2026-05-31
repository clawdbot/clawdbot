import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getTelegramRuntime } from "./runtime.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const STORE_VERSION = 3;
export const TELEGRAM_UPDATE_OFFSET_NAMESPACE = "telegram.update-offsets";
export const TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES = 1_000;

export type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
};

type TelegramUpdateOffsetStore = PluginStateKeyedStore<TelegramUpdateOffsetState>;

let updateOffsetStoreForTest: TelegramUpdateOffsetStore | undefined;

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeTelegramUpdateOffsetAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function openUpdateOffsetStore(env?: NodeJS.ProcessEnv): TelegramUpdateOffsetStore {
  return (
    updateOffsetStoreForTest ??
    getTelegramRuntime().state.openKeyedStore<TelegramUpdateOffsetState>({
      namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
      maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
      ...(env ? { env } : {}),
    })
  );
}

function extractBotIdFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  const [rawBotId] = trimmed.split(":", 1);
  if (!rawBotId || !/^\d+$/.test(rawBotId)) {
    return null;
  }
  return rawBotId;
}

function fingerprintFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  return fingerprintTelegramBotToken(trimmed);
}

function safeParseState(parsed: unknown): TelegramUpdateOffsetState | null {
  try {
    const state = parsed as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
      tokenFingerprint?: string | null;
    };
    if (state?.version !== STORE_VERSION && state?.version !== 2 && state?.version !== 1) {
      return null;
    }
    if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) {
      return null;
    }
    if (state.version >= 2 && state.botId !== null && typeof state.botId !== "string") {
      return null;
    }
    if (
      state.version === STORE_VERSION &&
      state.tokenFingerprint !== null &&
      typeof state.tokenFingerprint !== "string"
    ) {
      return null;
    }
    return {
      version: state.version,
      lastUpdateId: state.lastUpdateId ?? null,
      botId: state.version >= 2 ? (state.botId ?? null) : null,
      tokenFingerprint: state.version === STORE_VERSION ? (state.tokenFingerprint ?? null) : null,
    };
  } catch {
    return null;
  }
}

export type TelegramOffsetRotationReason = "bot-id-changed" | "token-rotated" | "legacy-state";

export type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number;
};

function rotationForToken(
  parsed: TelegramUpdateOffsetState,
  botToken?: string,
): TelegramUpdateOffsetRotationInfo | null {
  const currentBotId = extractBotIdFromToken(botToken);
  if (!currentBotId || parsed.lastUpdateId === null) {
    return null;
  }
  let reason: TelegramOffsetRotationReason | null = null;
  if (parsed.botId === null) {
    reason = "legacy-state";
  } else if (parsed.botId !== currentBotId) {
    reason = "bot-id-changed";
  } else if (parsed.tokenFingerprint === null) {
    reason = "legacy-state";
  } else if (parsed.tokenFingerprint !== fingerprintFromToken(botToken)) {
    reason = "token-rotated";
  }
  return reason
    ? {
        reason,
        previousBotId: parsed.botId,
        currentBotId,
        staleLastUpdateId: parsed.lastUpdateId,
      }
    : null;
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
  onRotationDetected?: (info: TelegramUpdateOffsetRotationInfo) => void | Promise<void>;
}): Promise<number | null> {
  const key = normalizeTelegramUpdateOffsetAccountId(params.accountId);
  let storedValue: unknown;
  try {
    storedValue = await openUpdateOffsetStore(params.env).lookup(key);
  } catch {
    storedValue = undefined;
  }
  const parsed = safeParseState(storedValue);
  if (!parsed) {
    return null;
  }
  const rotation = rotationForToken(parsed, params.botToken);
  if (rotation) {
    await params.onRotationDetected?.(rotation);
    return null;
  }
  return parsed.lastUpdateId;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUpdateId(params.updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
    tokenFingerprint: fingerprintFromToken(params.botToken),
  };
  await openUpdateOffsetStore(params.env).register(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
    payload,
  );
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await openUpdateOffsetStore(params.env).delete(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
  );
}

export function setTelegramUpdateOffsetStoreForTest(
  store: TelegramUpdateOffsetStore | undefined,
): void {
  updateOffsetStoreForTest = store;
}

export async function listTelegramLegacyUpdateOffsetEntries(params: {
  accountId?: string;
  persistedPath: string;
}): Promise<Array<{ key: string; value: TelegramUpdateOffsetState }>> {
  const { value } = await readJsonFileWithFallback<unknown>(params.persistedPath, null);
  const parsed = safeParseState(value);
  if (!parsed || parsed.lastUpdateId === null) {
    return [];
  }
  return [{ key: normalizeTelegramUpdateOffsetAccountId(params.accountId), value: parsed }];
}

export function shouldReplaceTelegramUpdateOffsetEntry(params: {
  existingValue: unknown;
  incomingValue: unknown;
  botToken?: string;
}): boolean {
  const existing = safeParseState(params.existingValue);
  const incoming = safeParseState(params.incomingValue);
  if (!incoming || incoming.lastUpdateId === null) {
    return false;
  }
  if (!existing || existing.lastUpdateId === null) {
    return true;
  }
  if (!params.botToken) {
    if (existing.botId && incoming.botId && existing.botId !== incoming.botId) {
      return false;
    }
    if (
      existing.tokenFingerprint &&
      incoming.tokenFingerprint &&
      existing.tokenFingerprint !== incoming.tokenFingerprint
    ) {
      return false;
    }
  }
  const incomingRotation = rotationForToken(incoming, params.botToken);
  if (incomingRotation) {
    return false;
  }
  const existingRotation = rotationForToken(existing, params.botToken);
  if (existingRotation) {
    return true;
  }
  return incoming.lastUpdateId > existing.lastUpdateId;
}
