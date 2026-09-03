import type { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isPidAlive } from "../../src/shared/pid-alive.js";

export { isPidAlive as isProcessAlive };

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  // Observe readiness before the deadline: a delayed wake can outlive both.
  while (!existsSync(filePath)) {
    if (Date.now() >= deadlineAt) {
      throw new Error(`timeout waiting for ${filePath}`);
    }
    await sleep(5);
  }
}

// writeFileSync can expose an open-truncate window, so wait for valid contents, not existence.
export async function waitForPidFile(filePath: string, timeoutMs: number): Promise<number> {
  const deadlineAt = Date.now() + timeoutMs;
  while (true) {
    if (existsSync(filePath)) {
      const pid = Number.parseInt(readFileSync(filePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    if (Date.now() >= deadlineAt) {
      throw new Error(`timeout waiting for pid in ${filePath}`);
    }
    await sleep(5);
  }
}

export async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  // A delayed worker wake can outlive both the deadline and the process.
  if (isPidAlive(pid)) {
    throw new Error(`process still alive: ${pid}`);
  }
}

export function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("child did not close before timeout")),
      timeoutMs,
    );
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
