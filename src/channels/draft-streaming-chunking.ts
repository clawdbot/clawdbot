// Shared resolver for channel live-preview draft chunk thresholds.
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { ChannelId } from "./plugins/types.core.js";
import { resolveChannelStreamingPreviewChunk, type StreamingCompatEntry } from "./streaming.js";

const DEFAULT_DRAFT_STREAM_MIN = 200;
const DEFAULT_DRAFT_STREAM_MAX = 800;

export type ChannelDraftStreamingChunking = {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
};

type ChannelDraftStreamingConfig = StreamingCompatEntry & {
  accounts?: Record<string, StreamingCompatEntry | undefined>;
};

export function resolveChannelDraftStreamingChunking(
  cfg: OpenClawConfig | undefined,
  channelId: ChannelId,
  accountId: string | null | undefined,
  opts: { fallbackLimit: number },
): ChannelDraftStreamingChunking {
  const textLimit = resolveTextChunkLimit(cfg, channelId, accountId, {
    fallbackLimit: opts.fallbackLimit,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelCfg = cfg?.channels?.[channelId] as ChannelDraftStreamingConfig | undefined;
  const accountCfg = resolveAccountEntry(channelCfg?.accounts, normalizedAccountId);
  const draftCfg =
    resolveChannelStreamingPreviewChunk(accountCfg) ??
    resolveChannelStreamingPreviewChunk(channelCfg);

  const maxRequested = Math.max(1, Math.floor(draftCfg?.maxChars ?? DEFAULT_DRAFT_STREAM_MAX));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(1, Math.floor(draftCfg?.minChars ?? DEFAULT_DRAFT_STREAM_MIN));
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
