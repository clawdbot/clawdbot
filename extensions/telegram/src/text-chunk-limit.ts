import type { OutboundDeliveryFormattingOptions } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { mergeTelegramAccountConfig, resolveDefaultTelegramAccountId } from "./accounts.js";
import { TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

export function resolveTelegramTextChunkLimit(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  formatting?: OutboundDeliveryFormattingOptions;
}): number {
  const richMessages =
    mergeTelegramAccountConfig(
      params.cfg,
      params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
    ).richMessages === true;
  const platformLimit =
    richMessages && params.formatting?.parseMode !== "HTML"
      ? TELEGRAM_RICH_TEXT_LIMIT
      : TELEGRAM_TEXT_CHUNK_LIMIT;
  return Math.min(
    resolveTextChunkLimit(params.cfg, "telegram", params.accountId ?? undefined, {
      fallbackLimit: platformLimit,
    }),
    platformLimit,
  );
}
