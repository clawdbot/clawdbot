export function isStartupTraceDuration(name: string): boolean {
  if (name.endsWith(".total") || name.startsWith("memory.")) {
    return false;
  }
  const metricName = name.slice(name.lastIndexOf(".") + 1);
  return !metricName.endsWith("Count") && !metricName.endsWith("Mb");
}

export function selectSlowStartupTraceDurations<T extends { avg: number | null }>(
  trace: Record<string, T>,
  limit: number,
): Array<[string, T]> {
  return Object.entries(trace)
    .filter(([name]) => isStartupTraceDuration(name))
    .toSorted((left, right) => (right[1].avg ?? 0) - (left[1].avg ?? 0))
    .slice(0, limit);
}
