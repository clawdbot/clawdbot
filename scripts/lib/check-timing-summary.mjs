export function formatMs(durationMs) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}

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
