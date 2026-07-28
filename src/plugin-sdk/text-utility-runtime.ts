// Focused low-level text/runtime helpers used by bundled plugins.
import type { BaseProbeResult } from "../channels/plugins/types.public.js";
import { withTimeout } from "../utils/with-timeout.js";

type ChannelProbeResult = BaseProbeResult & { elapsedMs?: number };

/** Run a channel probe with shared timeout, elapsed-time, and error-result handling. */
export async function runChannelProbe<
  TResult extends ChannelProbeResult,
  TErrorResult extends ChannelProbeResult = never,
>(
  timeoutMs: number | undefined,
  run: (context: { startedAt: number; elapsedMs: () => number }) => Promise<TResult>,
  onError?: (error: unknown) => TErrorResult,
): Promise<(TResult | TErrorResult) & { elapsedMs: number }> {
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  const finish = <T extends ChannelProbeResult>(result: T) => ({
    ...result,
    elapsedMs: result.elapsedMs ?? elapsedMs(),
  });
  try {
    return finish(await withTimeout(run({ startedAt, elapsedMs }), timeoutMs ?? 0));
  } catch (error) {
    if (!onError) {
      throw error;
    }
    return finish(onError(error));
  }
}

/** Escapes text for safe insertion into HTML text and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export {
  CONFIG_DIR,
  clamp,
  clampInt,
  clampNumber,
  displayPath,
  displayString,
  ensureDir,
  escapeRegExp,
  normalizeE164,
  pathExists,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  safeParseJson,
  shortenHomeInString,
  shortenHomePath,
  sleep,
  sliceUtf16Safe,
  truncateUtf16Safe,
} from "../utils.js";
export { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { withTimeout };
