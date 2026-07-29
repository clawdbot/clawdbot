// Temp State Dir script supports OpenClaw repository automation.
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cleanupSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type CleanupSignal = (typeof cleanupSignals)[number];

type E2eStateDir = {
  stateDir: string;
  created: boolean;
  cleanup: () => void;
  registerExitCleanup: () => void;
};

export async function createE2eStateDir(prefix: string, env = process.env): Promise<E2eStateDir> {
  const configuredStateDir = env.OPENCLAW_STATE_DIR?.trim();
  const created = !configuredStateDir;
  const stateDir = configuredStateDir || (await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const signalHandlers = new Map<CleanupSignal, () => void>();
  let cleaned = false;
  let cleanupRegistered = false;

  const cleanup = () => {
    if (created && !cleaned) {
      rmSync(stateDir, { force: true, recursive: true });
      cleaned = true;
    }
  };

  const unregisterSignalCleanup = () => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };

  const registerExitCleanup = () => {
    if (!created || cleanupRegistered) {
      return;
    }
    cleanupRegistered = true;
    process.once("exit", cleanup);
    for (const signal of cleanupSignals) {
      const handleSignal = () => {
        cleanup();
        unregisterSignalCleanup();
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      };
      signalHandlers.set(signal, handleSignal);
      process.once(signal, handleSignal);
    }
  };

  return { stateDir, created, cleanup, registerExitCleanup };
}
