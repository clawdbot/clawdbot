import { runIMessageCliJsonCommand } from "./cli-output.js";

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

  const recovery = runIMessageCliJsonCommand({
    cliPath,
    args: ["launch"],
    timeoutMs: BRIDGE_RECOVERY_TIMEOUT_MS,
  })
    .then(() => undefined)
    .finally(() => {
      recoveries.delete(cliPath);
    });
  recoveries.set(cliPath, recovery);
  return recovery;
}
