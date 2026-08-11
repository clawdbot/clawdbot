import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { tryReadJsonSync, writeJson } from "../infra/json-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  applyOpenClawDatabaseVerificationResults,
  collectOpenClawDatabaseVerifyTargets,
  OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS,
  OPENCLAW_DATABASE_VERIFY_INTERVAL_MS,
  runDatabaseVerifyWorker,
  terminateDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";
import { resolveOpenClawStateSqliteDir } from "./openclaw-state-db.paths.js";

const log = createSubsystemLogger("state/database-verify");
const DATABASE_VERIFY_STATE_FILENAME = "openclaw-database-verify.json";
const DATABASE_VERIFY_STATE_VERSION = 1;

type DatabaseVerifyState = {
  version: number;
  lastSuccessfulVerificationAt: number;
};

function resolveDatabaseVerifyStatePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveOpenClawStateSqliteDir(env), DATABASE_VERIFY_STATE_FILENAME);
}

function readLastSuccessfulVerificationAt(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const state = tryReadJsonSync<DatabaseVerifyState>(resolveDatabaseVerifyStatePath(env));
    if (
      state?.version !== DATABASE_VERIFY_STATE_VERSION ||
      !Number.isSafeInteger(state.lastSuccessfulVerificationAt) ||
      state.lastSuccessfulVerificationAt < 0
    ) {
      return undefined;
    }
    return state.lastSuccessfulVerificationAt;
  } catch (error) {
    log.warn("failed to read database integrity verifier cadence", { error: String(error) });
    return undefined;
  }
}

function resolveInitialDelayMs(env: NodeJS.ProcessEnv, now: number): number {
  const lastSuccessfulVerificationAt = readLastSuccessfulVerificationAt(env);
  if (lastSuccessfulVerificationAt === undefined) {
    return OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS;
  }
  const ageMs = now - lastSuccessfulVerificationAt;
  if (ageMs < 0 || ageMs >= OPENCLAW_DATABASE_VERIFY_INTERVAL_MS) {
    return OPENCLAW_DATABASE_VERIFY_INITIAL_DELAY_MS;
  }
  return OPENCLAW_DATABASE_VERIFY_INTERVAL_MS - ageMs;
}

function didCompleteVerificationPass(
  targets: readonly { path: string }[],
  results: readonly { ok: boolean; path: string }[],
): boolean {
  if (targets.length === 0 || results.length !== targets.length) {
    return false;
  }
  const pendingPaths = new Set(targets.map((target) => target.path));
  for (const result of results) {
    if (!result.ok || !pendingPaths.delete(result.path)) {
      return false;
    }
  }
  return pendingPaths.size === 0;
}

async function recordSuccessfulVerification(env: NodeJS.ProcessEnv, completedAt: number) {
  try {
    await writeJson(
      resolveDatabaseVerifyStatePath(env),
      {
        version: DATABASE_VERIFY_STATE_VERSION,
        lastSuccessfulVerificationAt: completedAt,
      } satisfies DatabaseVerifyState,
      { dirMode: 0o700, mode: 0o600, trailingNewline: true },
    );
  } catch (error) {
    log.warn("failed to persist database integrity verifier cadence", { error: String(error) });
  }
}

/** Start the Gateway-owned delayed daily integrity verifier. */
export function startOpenClawDatabaseIntegrityVerifier(options: { env: NodeJS.ProcessEnv }): {
  stop: () => Promise<void>;
} {
  let activeWorker: ChildProcess | undefined;
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
          if (didCompleteVerificationPass(targets, results)) {
            await recordSuccessfulVerification(options.env, Date.now());
          }
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

  schedule(resolveInitialDelayMs(options.env, Date.now()));
  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (activeWorker) {
        await terminateDatabaseVerifyWorker(activeWorker);
      }
      activeWorker = undefined;
    },
  };
}
