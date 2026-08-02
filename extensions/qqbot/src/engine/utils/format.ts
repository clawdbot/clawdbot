/**
 * General formatting and string utilities.
 * 通用格式化与字符串工具。
 *
 * Pure utility functions, with duration presentation from the plugin-local dependency.
 */
import prettyMilliseconds from "pretty-ms";

/** Format a millisecond duration into a human-readable string (e.g. "5m 30s"). */
export function formatDuration(durationMs: number): string {
  if (durationMs <= 0) {
    return "0s";
  }
  const roundedMs =
    durationMs < 1000 ? Math.round(durationMs) : Math.round(durationMs / 1000) * 1000;
  return prettyMilliseconds(roundedMs, {
    unitCount: 2,
  });
}
