import type { Worker } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  applyOpenClawDatabaseVerificationResults,
  collectOpenClawDatabaseVerifyTargets,
  OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS,
  OPENCLAW_DATABASE_VERIFY_INTERVAL_MS,
  runDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";

const log = createSubsystemLogger("state/database-verify");

/** Start the Gateway-owned delayed daily integrity verifier. */
export function startOpenClawDatabaseIntegrityVerifier(options: { env: NodeJS.ProcessEnv }): {
  stop: () => Promise<void>;
} {
  let activeWorker: Worker | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    timer = setTimeout(() => void run(), delayMs);
    timer.unref?.();
  };
  const run = async () => {
    timer = undefined;
    try {
      const targets = collectOpenClawDatabaseVerifyTargets(options);
      if (targets.length > 0) {
        const results = await runDatabaseVerifyWorker(targets, {
          onWorker: (worker) => {
            activeWorker = worker;
          },
        });
        if (!stopped) {
          applyOpenClawDatabaseVerificationResults({ ...options, results, targets });
        }
      }
    } catch (error) {
      if (!stopped) {
        log.error("database integrity verifier failed", { error: String(error) });
      }
    } finally {
      activeWorker = undefined;
      if (!stopped) {
        schedule(OPENCLAW_DATABASE_VERIFY_INTERVAL_MS);
      }
    }
  };

  schedule(OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS);
  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await activeWorker?.terminate();
      activeWorker = undefined;
    },
  };
}
