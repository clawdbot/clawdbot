export type FormatDurationSecondsOptions = {
  decimals?: number;
  unit?: "s" | "seconds";
};

export function formatDurationSeconds(
  ms: number,
  options: FormatDurationSecondsOptions = {},
): string {
  if (!Number.isFinite(ms)) return "unknown";
  const decimals = options.decimals ?? 1;
  const unit = options.unit ?? "s";
  const seconds = Math.max(0, ms) / 1000;
  const fixed = seconds.toFixed(Math.max(0, decimals));
  const trimmed = fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  return unit === "seconds" ? `${trimmed} seconds` : `${trimmed}s`;
}

export type FormatDurationMsOptions = {
  decimals?: number;
  unit?: "s" | "seconds";
};

export function formatDurationMs(
  ms: number,
  options: FormatDurationMsOptions = {},
): string {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  return formatDurationSeconds(ms, {
    decimals: options.decimals ?? 2,
    unit: options.unit ?? "s",
  });
}
