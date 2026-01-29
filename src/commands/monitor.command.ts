import type { RuntimeEnv } from "../runtime.js";
import { runMonitorTui } from "../tui/monitor.js";

export async function monitorCommand(
  opts: { intervalMs?: number },
  runtime: RuntimeEnv,
) {
  await runMonitorTui(runtime, { intervalMs: opts.intervalMs ?? 2000 });
}
