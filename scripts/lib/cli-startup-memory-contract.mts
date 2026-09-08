// Saved CLI reports must not compare last-exiting-process RSS with attributed runtime RSS.
export const CLI_RUNTIME_MEMORY_METRIC = "cli-runtime-max-rss-v1";

export function cliStartupMemoryMetric(suite: unknown): string {
  const metric =
    typeof suite === "object" && suite !== null && "memoryMetric" in suite
      ? suite.memoryMetric
      : undefined;
  if (metric === undefined) {
    return "legacy-last-marker";
  }
  if (metric !== CLI_RUNTIME_MEMORY_METRIC) {
    throw new Error(`Unknown CLI RSS metric: ${JSON.stringify(metric)}`);
  }
  return metric;
}

export function assertCompatibleCliStartupMemoryMetrics(
  baseline: unknown,
  candidate: unknown,
): void {
  const before = cliStartupMemoryMetric(baseline);
  const after = cliStartupMemoryMetric(candidate);
  if (before !== after) {
    throw new Error(
      `Incompatible CLI RSS metrics: ${before} vs ${after}. Collect both reports with the same benchmark metric; historical RSS cannot be relabeled.`,
    );
  }
}
