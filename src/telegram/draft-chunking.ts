import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { getChannelDock } from "../channels/dock.js";
import type { MoltbotConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/session-key.js";

const DEFAULT_TELEGRAM_DRAFT_STREAM_MIN = 200;
const DEFAULT_TELEGRAM_DRAFT_STREAM_MAX = 800;

export function resolveTelegramDraftStreamingChunking(
  cfg: MoltbotConfig | undefined,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerChunkLimit = getChannelDock("telegram")?.outbound?.textChunkLimit;
  const textLimit = resolveTextChunkLimit(cfg, "telegram", accountId, {
    fallbackLimit: providerChunkLimit,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const draftCfg =
    cfg?.channels?.telegram?.accounts?.[normalizedAccountId]?.draftChunk ??
    cfg?.channels?.telegram?.draftChunk;

  const maxRequested = Math.max(
    1,
    Math.floor(draftCfg?.maxChars ?? DEFAULT_TELEGRAM_DRAFT_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(draftCfg?.minChars ?? DEFAULT_TELEGRAM_DRAFT_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
