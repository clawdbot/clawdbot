// Qa Lab plugin module implements process wait helper behavior.
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const POLL_INTERVAL_MS = 10;
// Generous ceiling for loaded CI runners: callers synchronize on the asserted
// state, so a large bound only delays failure reporting, never success.
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForFile(
  filePath: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${filePath}`);
}

// writeFileSync exposes an open-truncate window to observers, so wait for a
// parseable pid, never bare existence; an existence wait reads "" into NaN.
export async function waitForPidFile(
  filePath: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<number> {
  const deadlineAt = Date.now() + timeoutMs;
  let lastContent: string | undefined;
  while (Date.now() < deadlineAt) {
    lastContent = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (lastContent !== undefined) {
      const pid = Number.parseInt(lastContent, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const lastState =
    lastContent === undefined
      ? "file missing"
      : `unparsable content ${JSON.stringify(lastContent)}`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for pid file ${filePath} (${lastState})`);
}

export async function waitForDead(pid: number, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for pid ${pid} to exit`);
}
