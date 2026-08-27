// Telegram plugin module implements direct-message history limit resolution.
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";

const DEFAULT_TELEGRAM_DM_HISTORY_LIMIT = 10;

export function resolveTelegramDmHistoryLimit(params: {
  config: TelegramAccountConfig;
  senderId?: string | number;
}): number {
  const senderId = params.senderId === undefined ? undefined : String(params.senderId);
  const override = senderId ? params.config.dms?.[senderId]?.historyLimit : undefined;
  return Math.max(0, override ?? params.config.dmHistoryLimit ?? DEFAULT_TELEGRAM_DM_HISTORY_LIMIT);
}
