import type { ClawdbotConfig } from "../../config/config.js";
import { PROVIDER_IDS } from "../../providers/registry.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { resolveTextChunkLimit, type TextChunkProvider } from "../chunk.js";

const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;
const DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS = 1000;
const DEFAULT_TELEGRAM_DRAFT_STREAM_MIN = 200;
const DEFAULT_TELEGRAM_DRAFT_STREAM_MAX = 800;
const PROVIDER_COALESCE_DEFAULTS: Partial<
  Record<TextChunkProvider, { minChars: number; idleMs: number }>
> = {
  signal: { minChars: 1500, idleMs: 1000 },
  slack: { minChars: 1500, idleMs: 1000 },
  discord: { minChars: 1500, idleMs: 1000 },
};

const BLOCK_CHUNK_PROVIDERS = new Set<TextChunkProvider>([
  ...PROVIDER_IDS,
  "webchat",
]);

function normalizeChunkProvider(
  provider?: string,
): TextChunkProvider | undefined {
  if (!provider) return undefined;
  const cleaned = provider.trim().toLowerCase();
  return BLOCK_CHUNK_PROVIDERS.has(cleaned as TextChunkProvider)
    ? (cleaned as TextChunkProvider)
    : undefined;
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
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId);
  const chunkCfg = cfg?.agents?.defaults?.blockStreamingChunk;
  const maxRequested = Math.max(
    1,
    Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minFallback = DEFAULT_BLOCK_STREAM_MIN;
  const minRequested = Math.max(
    1,
    Math.floor(chunkCfg?.minChars ?? minFallback),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    chunkCfg?.breakPreference === "newline" ||
    chunkCfg?.breakPreference === "sentence"
      ? chunkCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}

export function resolveTelegramDraftStreamingChunking(
  cfg: ClawdbotConfig | undefined,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerKey: TextChunkProvider = "telegram";
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId);
  const normalizedAccountId = normalizeAccountId(accountId);
  const draftCfg =
    cfg?.telegram?.accounts?.[normalizedAccountId]?.draftChunk ??
    cfg?.telegram?.draftChunk;

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
    draftCfg?.breakPreference === "newline" ||
    draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
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
  const textLimit = resolveTextChunkLimit(cfg, providerKey, accountId);
  const normalizedAccountId = normalizeAccountId(accountId);
  const providerDefaults = providerKey
    ? PROVIDER_COALESCE_DEFAULTS[providerKey]
    : undefined;
  const providerCfg = (() => {
    if (!cfg || !providerKey) return undefined;
    if (providerKey === "whatsapp") {
      return (
        cfg.whatsapp?.accounts?.[normalizedAccountId]?.blockStreamingCoalesce ??
        cfg.whatsapp?.blockStreamingCoalesce
      );
    }
    if (providerKey === "telegram") {
      return (
        cfg.telegram?.accounts?.[normalizedAccountId]?.blockStreamingCoalesce ??
        cfg.telegram?.blockStreamingCoalesce
      );
    }
    if (providerKey === "discord") {
      return (
        cfg.discord?.accounts?.[normalizedAccountId]?.blockStreamingCoalesce ??
        cfg.discord?.blockStreamingCoalesce
      );
    }
    if (providerKey === "slack") {
      return (
        cfg.slack?.accounts?.[normalizedAccountId]?.blockStreamingCoalesce ??
        cfg.slack?.blockStreamingCoalesce
      );
    }
    if (providerKey === "signal") {
      return (
        cfg.signal?.accounts?.[normalizedAccountId]?.blockStreamingCoalesce ??
        cfg.signal?.blockStreamingCoalesce
      );
    }
    if (providerKey === "imessage") {
      return (
        cfg.imessage?.accounts?.[normalizedAccountId]?.blockStreamingCoalesce ??
        cfg.imessage?.blockStreamingCoalesce
      );
    }
    if (providerKey === "msteams") {
      return cfg.msteams?.blockStreamingCoalesce;
    }
    return undefined;
  })();
  const coalesceCfg =
    providerCfg ?? cfg?.agents?.defaults?.blockStreamingCoalesce;
  const minRequested = Math.max(
    1,
    Math.floor(
      coalesceCfg?.minChars ??
        providerDefaults?.minChars ??
        chunking?.minChars ??
        DEFAULT_BLOCK_STREAM_MIN,
    ),
  );
  const maxRequested = Math.max(
    1,
    Math.floor(coalesceCfg?.maxChars ?? textLimit),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minChars = Math.min(minRequested, maxChars);
  const idleMs = Math.max(
    0,
    Math.floor(
      coalesceCfg?.idleMs ??
        providerDefaults?.idleMs ??
        DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS,
    ),
  );
  const preference = chunking?.breakPreference ?? "paragraph";
  const joiner =
    preference === "sentence" ? " " : preference === "newline" ? "\n" : "\n\n";
  return {
    minChars,
    maxChars,
    idleMs,
    joiner,
  };
}
