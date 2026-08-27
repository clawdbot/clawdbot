// Vitest child-process environment and native worker budget policy.
import { resolveLocalVitestEnv } from "./vitest-local-scheduling.mts";

function parseExplicitVitestWorkerBudget(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d+$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveExplicitVitestWorkerBudget(env: NodeJS.ProcessEnv): number | null {
  return parseExplicitVitestWorkerBudget(
    env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS,
  );
}

function shouldApplyNativeWorkerBudget(env: NodeJS.ProcessEnv): boolean {
  if (env.RAYON_NUM_THREADS?.trim() && env.TOKIO_WORKER_THREADS?.trim()) {
    return false;
  }
  return (
    env.OPENCLAW_TEST_PROJECTS_SERIAL === "1" || resolveExplicitVitestWorkerBudget(env) !== null
  );
}

function resolveNativeWorkerCount(env: NodeJS.ProcessEnv): number {
  return Math.min(resolveExplicitVitestWorkerBudget(env) ?? 1, 4);
}

/** Applies local Vitest scheduling and native worker budget env. */
export function resolveVitestProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const baseEnv = resolveLocalVitestEnv(env);
  if (!shouldApplyNativeWorkerBudget(baseEnv)) {
    return baseEnv;
  }

  const nativeWorkerCount = String(resolveNativeWorkerCount(baseEnv));
  return {
    ...baseEnv,
    RAYON_NUM_THREADS: baseEnv.RAYON_NUM_THREADS?.trim() || nativeWorkerCount,
    TOKIO_WORKER_THREADS: baseEnv.TOKIO_WORKER_THREADS?.trim() || nativeWorkerCount,
  };
}
