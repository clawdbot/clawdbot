export function taskTimestampMs(value: number | string | undefined): number {
  const timestamp =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
