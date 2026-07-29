// Formats compact timing summaries for changed-check command groups.
/** Format a duration in milliseconds for command summaries. */
export function formatMs(durationMs) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}

/** Print a stderr timing summary for a list of named command results. */
export function printTimingSummary(label, timings, options = {}) {
  if (options.skipWhenAllOk && timings.every((timing) => timing.status === 0)) {
    return;
  }

  console.error(`\n[${label}] summary`);
  for (const timing of timings) {
    const status = timing.status === 0 ? "ok" : `failed:${timing.status}`;
    console.error(
      `${formatMs(timing.durationMs).padStart(8)}  ${status.padEnd(9)}  ${timing.name}`,
    );
  }
}
