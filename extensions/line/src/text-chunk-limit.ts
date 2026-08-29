// Line plugin module owns the outbound text chunk size.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";

/** LINE rejects the whole push/reply with HTTP 400 when any text message is longer. */
export const LINE_TEXT_CHUNK_LIMIT = 5000;

/** Configured LINE chunk size, bounded by what the platform accepts. */
export function resolveLineTextChunkLimit(params: {
  cfg: OpenClawConfig | undefined;
  accountId?: string | null;
}): number {
  return Math.min(
    resolveTextChunkLimit(params.cfg, "line", params.accountId ?? undefined, {
      fallbackLimit: LINE_TEXT_CHUNK_LIMIT,
    }),
    LINE_TEXT_CHUNK_LIMIT,
  );
}
