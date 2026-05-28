/**
 * Central timing instrumentation for startup profiling.
 * Enable with OPENCLAW_TIMING=1 environment variable.
 */

const ENABLED = process.env.OPENCLAW_TIMING === "1";
const timings: Array<{ label: string; ms: number }> = [];
let lastTime = Date.now();

export function resetTimings(): void {
  if (!ENABLED) {
    return;
  }
  timings.length = 0;
  lastTime = Date.now();
}

export function time(label: string): void {
  if (!ENABLED) {
    return;
  }
  const now = Date.now();
  timings.push({ label, ms: now - lastTime });
  lastTime = now;
}

export function printTimings(): void {
  if (!ENABLED || timings.length === 0) {
    return;
  }
  console.error("\n--- Startup Timings ---");
  for (const t of timings) {
    console.error(`  ${t.label}: ${t.ms}ms`);
  }
  console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
  console.error("------------------------\n");
}
