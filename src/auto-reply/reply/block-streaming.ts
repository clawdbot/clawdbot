import type { ClawdbotConfig } from "../../config/config.js";
import { resolveTextChunkLimit, type TextChunkProvider } from "../chunk.js";

const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;

const BLOCK_CHUNK_PROVIDERS = new Set<TextChunkProvider>([
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "matrix",
  "signal",
  "imessage",
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

export function resolveBlockStreamingChunking(
  cfg: ClawdbotConfig | undefined,
  provider?: string,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerKey = normalizeChunkProvider(provider);
  const textLimit = resolveTextChunkLimit(cfg, providerKey);
  const chunkCfg = cfg?.agent?.blockStreamingChunk;
  const maxRequested = Math.max(
    1,
    Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(chunkCfg?.minChars ?? DEFAULT_BLOCK_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    chunkCfg?.breakPreference === "newline" ||
    chunkCfg?.breakPreference === "sentence"
      ? chunkCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
