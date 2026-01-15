import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { BlockStreamingCoalesceConfig } from "../../config/types.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  listDeliverableMessageChannels,
} from "../../utils/message-channel.js";
import { resolveTextChunkLimit, type TextChunkProvider } from "../chunk.js";

const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;
const DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS = 1000;
const getBlockChunkProviders = () =>
  new Set<TextChunkProvider>([...listDeliverableMessageChannels(), INTERNAL_MESSAGE_CHANNEL]);

function normalizeChunkProvider(provider?: string): TextChunkProvider | undefined {
  if (!provider) return undefined;
  const cleaned = provider.trim().toLowerCase();
  return getBlockChunkProviders().has(cleaned as TextChunkProvider)
    ? (cleaned as TextChunkProvider)
    : undefined;
}

type ProviderBlockStreamingConfig = {
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  accounts?: Record<string, { blockStreamingCoalesce?: BlockStreamingCoalesceConfig }>;
};

function resolveProviderBlockStreamingCoalesce(params: {
  cfg: ClawdbotConfig | undefined;
  providerKey?: TextChunkProvider;
  accountId?: string | null;
}): BlockStreamingCoalesceConfig | undefined {
  const { cfg, providerKey, accountId } = params;
  if (!cfg || !providerKey) return undefined;
  const providerCfg = (cfg as Record<string, unknown>)[providerKey];
  if (!providerCfg || typeof providerCfg !== "object") return undefined;
  const normalizedAccountId = normalizeAccountId(accountId);
  const typed = providerCfg as ProviderBlockStreamingConfig;
  const accountCfg = typed.accounts?.[normalizedAccountId];
  return accountCfg?.blockStreamingCoalesce ?? typed.blockStreamingCoalesce;
}

export type BlockStreamingCoalescing = {
  minChars: number;
  maxChars: number;
  idleMs: number;
  joiner: string;
};

export function resolveBlockStreamingChunking(
  cfg: ClawdbotConfig | undefined,
  provider?: string,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerKey = normalizeChunkProvider(provider);
  const providerId = providerKey ? normalizeChannelId(providerKey) : null;
  const providerChunkLimit = providerId
    ? getChannelDock(providerId)?.outbound?.textChunkLimit
    : undefined;
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId, {
    fallbackLimit: providerChunkLimit,
  });
  const chunkCfg = cfg?.agents?.defaults?.blockStreamingChunk;
  const maxRequested = Math.max(1, Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minFallback = DEFAULT_BLOCK_STREAM_MIN;
  const minRequested = Math.max(1, Math.floor(chunkCfg?.minChars ?? minFallback));
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    chunkCfg?.breakPreference === "newline" || chunkCfg?.breakPreference === "sentence"
      ? chunkCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}

export function resolveBlockStreamingCoalescing(
  cfg: ClawdbotConfig | undefined,
  provider?: string,
  accountId?: string | null,
  chunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  },
): BlockStreamingCoalescing | undefined {
  const providerKey = normalizeChunkProvider(provider);
  const providerId = providerKey ? normalizeChannelId(providerKey) : null;
  const providerChunkLimit = providerId
    ? getChannelDock(providerId)?.outbound?.textChunkLimit
    : undefined;
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId, {
    fallbackLimit: providerChunkLimit,
  });
  const providerDefaults = providerId
    ? getChannelDock(providerId)?.streaming?.blockStreamingCoalesceDefaults
    : undefined;
  const providerCfg = resolveProviderBlockStreamingCoalesce({
    cfg,
    providerKey,
    accountId,
  });
  const coalesceCfg = providerCfg ?? cfg?.agents?.defaults?.blockStreamingCoalesce;
  const minRequested = Math.max(
    1,
    Math.floor(
      coalesceCfg?.minChars ??
        providerDefaults?.minChars ??
        chunking?.minChars ??
        DEFAULT_BLOCK_STREAM_MIN,
    ),
  );
  const maxRequested = Math.max(1, Math.floor(coalesceCfg?.maxChars ?? textLimit));
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minChars = Math.min(minRequested, maxChars);
  const idleMs = Math.max(
    0,
    Math.floor(
      coalesceCfg?.idleMs ?? providerDefaults?.idleMs ?? DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS,
    ),
  );
  const preference = chunking?.breakPreference ?? "paragraph";
  const joiner = preference === "sentence" ? " " : preference === "newline" ? "\n" : "\n\n";
  return {
    minChars,
    maxChars,
    idleMs,
    joiner,
  };
}
