// Runs tsgo through local resource policy and sparse-checkout guards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFlagValue } from "./lib/arg-utils.mts";
import {
  applyLocalTsgoPolicy,
  ensureRepoToolNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mts";

// Declared locally, as sibling scripts do, rather than imported from packages/:
// a static import there resolves before the sparse-checkout guard can report a
// missing project, turning a clean skip into ERR_MODULE_NOT_FOUND. Mirrors
// normalization-core's MAX_TIMER_TIMEOUT_MS.
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export function resolveTsgoTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.OPENCLAW_TSGO_TIMEOUT_MS?.trim()) {
    return undefined;
  }
  return Math.min(
    readPositiveEnvInt("OPENCLAW_TSGO_TIMEOUT_MS", env, MAX_TIMER_TIMEOUT_MS),
    MAX_TIMER_TIMEOUT_MS,
  );
}

async function main(): Promise<void> {
  const hostResources = {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const { args: finalArgs, env } = applyLocalTsgoPolicy(
    process.argv.slice(2),
    resolveLocalCheckEnv(process.env),
    hostResources,
  );

  const tsgoPath = resolveRepoToolBinPath("tsgo");
  const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
  if (tsBuildInfoFile) {
    fs.mkdirSync(path.dirname(path.resolve(tsBuildInfoFile)), { recursive: true });
  }
  const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd: process.cwd() });
  if (sparseGuardError) {
    console.error(sparseGuardError);
    if (shouldSkipSparseTsgoGuardError(env)) {
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
    return;
  }

  ensureRepoToolNodeModulesLink(tsgoPath);
  let timeoutMs: number | undefined;
  try {
    timeoutMs = resolveTsgoTimeoutMs(env);
  } catch {
    // main() is top-level awaited, so an escaping parse error would surface as a raw
    // module rejection with no guidance about the variable that caused it.
    console.error(
      `[tsgo] OPENCLAW_TSGO_TIMEOUT_MS must be plain decimal digits with no leading zero, sign, exponent, or decimal point, between 1 and ${Number.MAX_SAFE_INTEGER}; got ${env.OPENCLAW_TSGO_TIMEOUT_MS}. Unset it to disable the watchdog.`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    // Managed cleanup forwards SIGTERM before bounded SIGKILL escalation, then
    // joins the compiler group and output before reporting a timeout.
    process.exitCode = await runManagedCommand({
      bin: tsgoPath,
      args: finalArgs,
      env,
      // The compiler owns a nested group that outer preparation cannot verify.
      requireProcessTreeExit: process.platform !== "win32",
      timeoutMs,
    });
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code !== "ETIMEDOUT") {
      throw error;
    }
    console.error(
      `[tsgo] no completion after ${timeoutMs}ms; killed the tsgo process tree. Raise OPENCLAW_TSGO_TIMEOUT_MS for intentionally longer builds, or unset it to disable the watchdog.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
