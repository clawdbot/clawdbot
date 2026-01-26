import type { ChannelDirectoryEntry, ClawdbotConfig } from "clawdbot/plugin-sdk";

import { resolveTelegramUserAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export type TelegramUserDirectoryConfigParams = {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

function normalizePeerEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/^(telegram-user|telegram|tg):/i, "")
    .replace(/^user:/i, "")
    .trim();
  if (!cleaned) return null;
  if (/^-?\d+$/.test(cleaned)) return cleaned;
  const withoutAt = cleaned.replace(/^@/, "");
  if (!withoutAt) return null;
  return `@${withoutAt}`;
}

export async function listTelegramUserDirectoryPeersFromConfig(
  params: TelegramUserDirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveTelegramUserAccount({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const q = params.query?.trim().toLowerCase() || "";
  const raw = [
    ...(account.config.allowFrom ?? []).map((entry) => String(entry)),
    ...(account.config.groupAllowFrom ?? []).map((entry) => String(entry)),
  ];
  return Array.from(
    new Set(
      raw
        .map((entry) => entry.trim())
        .filter((entry) => Boolean(entry) && entry !== "*"),
    ),
  )
    .map((entry) => normalizePeerEntry(entry))
    .filter((id): id is string => Boolean(id))
    .filter((id) => (q ? id.toLowerCase().includes(q) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "user", id }) as const);
}

export async function listTelegramUserDirectoryGroupsFromConfig(
  params: TelegramUserDirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveTelegramUserAccount({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const q = params.query?.trim().toLowerCase() || "";
  return Object.keys(account.config.groups ?? {})
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && id !== "*")
    .filter((id) => (q ? id.toLowerCase().includes(q) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "group", id }) as const);
}

