import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { withTimeout } from "@openclaw/fs-safe/advanced";

export async function stopChildProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exitWait = new AbortController();
  const exited = once(child, "exit", { signal: exitWait.signal });
  try {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const timeoutError = new Error(
        `child ${String(child.pid)} did not exit within ${timeoutMs}ms after ${signal}`,
      );
      child.kill(signal);
      try {
        await withTimeout(exited, timeoutMs, { createError: () => timeoutError });
        return;
      } catch (error) {
        // Only the grace deadline escalates; child errors and the final deadline remain failures.
        if (error !== timeoutError || signal === "SIGKILL") {
          throw error;
        }
      }
    }
  } finally {
    // Remove once's exit/error listeners even if kill throws or the final wait times out.
    exitWait.abort();
    await exited.catch(() => undefined);
  }
}
