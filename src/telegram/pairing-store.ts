import type { ClawdbotConfig } from "../config/config.js";
import {
  addProviderAllowFromStoreEntry,
  approveProviderPairingCode,
  listProviderPairingRequests,
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";

export type TelegramPairingListEntry = {
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
};

const PROVIDER = "telegram" as const;

export async function readTelegramAllowFromStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return readProviderAllowFromStore(PROVIDER, env);
}

export async function addTelegramAllowFromStoreEntry(params: {
  entry: string | number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  return addProviderAllowFromStoreEntry({
    provider: PROVIDER,
    entry: params.entry,
    env: params.env,
  });
}

export async function listTelegramPairingRequests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramPairingListEntry[]> {
  const list = await listProviderPairingRequests(PROVIDER, env);
  return list.map((r) => ({
    chatId: r.id,
    code: r.code,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    username: r.meta?.username,
    firstName: r.meta?.firstName,
    lastName: r.meta?.lastName,
  }));
}

export async function upsertTelegramPairingRequest(params: {
  chatId: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  return upsertProviderPairingRequest({
    provider: PROVIDER,
    id: String(params.chatId),
    env: params.env,
    meta: {
      username: params.username,
      firstName: params.firstName,
      lastName: params.lastName,
    },
  });
}

export async function approveTelegramPairingCode(params: {
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ chatId: string; entry?: TelegramPairingListEntry } | null> {
  const res = await approveProviderPairingCode({
    provider: PROVIDER,
    code: params.code,
    env: params.env,
  });
  if (!res) return null;
  const entry = res.entry
    ? {
        chatId: res.entry.id,
        code: res.entry.code,
        createdAt: res.entry.createdAt,
        lastSeenAt: res.entry.lastSeenAt,
        username: res.entry.meta?.username,
        firstName: res.entry.meta?.firstName,
        lastName: res.entry.meta?.lastName,
      }
    : undefined;
  return { chatId: res.id, entry };
}

export async function resolveTelegramEffectiveAllowFrom(params: {
  cfg: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ dm: string[]; group: string[] }> {
  const env = params.env ?? process.env;
  const cfgAllowFrom = (params.cfg.telegram?.allowFrom ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(telegram|tg):/i, ""))
    .filter((v) => v !== "*");
  const cfgGroupAllowFrom = (params.cfg.telegram?.groupAllowFrom ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(telegram|tg):/i, ""))
    .filter((v) => v !== "*");
  const storeAllowFrom = await readTelegramAllowFromStore(env);

  const dm = Array.from(new Set([...cfgAllowFrom, ...storeAllowFrom]));
  const group = Array.from(
    new Set([
      ...(cfgGroupAllowFrom.length > 0 ? cfgGroupAllowFrom : cfgAllowFrom),
      ...storeAllowFrom,
    ]),
  );
  return { dm, group };
}
