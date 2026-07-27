// State dir environment helpers isolate state paths during tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

// OPENCLAW_STATE_DIR test helpers isolate stateful tests and restore the caller
// environment even when session cleanup fails.
export function snapshotStateDirEnv() {
  return captureEnv(["OPENCLAW_STATE_DIR"]);
}

export function restoreStateDirEnv(snapshot: ReturnType<typeof snapshotStateDirEnv>): void {
  snapshot.restore();
}

export function setStateDirEnv(stateDir: string): void {
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
}

export async function withStateDirEnv<T>(
  prefix: string,
  fn: (ctx: { tempRoot: string; stateDir: string }) => Promise<T>,
): Promise<T> {
  const snapshot = snapshotStateDirEnv();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(tempRoot, "state");
  await fs.mkdir(stateDir, { recursive: true });
  setStateDirEnv(stateDir);
  try {
    return await fn({ tempRoot, stateDir });
  } finally {
    // Session state cleanup may race with assertions in failing tests; never let
    // that cleanup failure hide the original test error or skip env restoration.
    await cleanupSessionStateForTest().catch(() => undefined);
    restoreStateDirEnv(snapshot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
