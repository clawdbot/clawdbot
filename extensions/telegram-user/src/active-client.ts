import type { TelegramClient } from "@mtcute/node";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

const activeClients = new Map<string, TelegramClient>();

function resolveAccountKey(accountId?: string | null): string {
  return normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
}

export function setActiveTelegramUserClient(
  accountId: string | null | undefined,
  next: TelegramClient | null,
) {
  const key = resolveAccountKey(accountId);
  if (next) {
    activeClients.set(key, next);
    return;
  }
  activeClients.delete(key);
}

export function getActiveTelegramUserClient(accountId?: string | null): TelegramClient | null {
  const key = resolveAccountKey(accountId);
  return activeClients.get(key) ?? null;
}
