import { spawn } from "node:child_process";

const BRIDGE_RECOVERY_TIMEOUT_MS = 30_000;
const recoveries = new Map<string, Promise<void>>();

/**
 * Re-inject the private bridge after imsg has positively identified it as
 * unresponsive. This deliberately does not retry the failed mutation: imsg may
 * still reconcile a published send, so replaying it could duplicate a message.
 */
export function recoverIMessageBridge(cliPath: string): Promise<void> {
  const existing = recoveries.get(cliPath);
  if (existing) {
    return existing;
  }

  const recovery = new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath, ["launch", "--json"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4096) {
        stderr += String(chunk).slice(0, 4096 - stderr.length);
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("imsg launch timed out while recovering the private API bridge"));
    }, BRIDGE_RECOVERY_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          `imsg launch failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  }).finally(() => {
    recoveries.delete(cliPath);
  });
  recoveries.set(cliPath, recovery);
  return recovery;
}
