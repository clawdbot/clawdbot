// Runs tsgo through local resource policy and sparse-checkout guards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFlagValue } from "./lib/arg-utils.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import {
  applyLocalTsgoPolicy,
  ensureRepoToolNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation, runManagedCommand } from "./lib/managed-child-process.mts";
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

/** Prepare one compiler invocation; the caller owns its process group and deadline. */
export function prepareTsgoCommand(
  args: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const hostResources = {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const { args: finalArgs, env } = applyLocalTsgoPolicy(
    args,
    resolveLocalCheckEnv(baseEnv),
    hostResources,
  );

  const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd });
  const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
  if (tsBuildInfoFile) {
    fs.mkdirSync(path.dirname(path.resolve(cwd, tsBuildInfoFile)), { recursive: true });
  }
  const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd });
  if (sparseGuardError) {
    if (shouldSkipSparseTsgoGuardError(env)) {
      console.error(sparseGuardError);
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      return null;
    }
    throw new Error(sparseGuardError);
  }

  ensureRepoToolNodeModulesLink(tsgoPath, { cwd });
  let timeoutMs: number | undefined;
  try {
    timeoutMs = resolveTsgoTimeoutMs(env);
  } catch {
    throw new Error(
      `[tsgo] OPENCLAW_TSGO_TIMEOUT_MS must be plain decimal digits with no leading zero, sign, exponent, or decimal point, between 1 and ${Number.MAX_SAFE_INTEGER}; got ${env.OPENCLAW_TSGO_TIMEOUT_MS}. Unset it to disable the watchdog.`,
    );
  }
  const { command: bin, ...invocation } = createManagedCommandInvocation({
    bin: tsgoPath,
    args: finalArgs,
    env,
  });
  return { ...invocation, bin, cwd, env, timeoutMs };
}

async function main(): Promise<void> {
  let command: ReturnType<typeof prepareTsgoCommand>;
  try {
    command = prepareTsgoCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!command) {
    return;
  }
  try {
    // Managed cleanup forwards SIGTERM before bounded SIGKILL escalation, then
    // joins the compiler group and output before reporting a timeout.
    process.exitCode = await runManagedCommand({
      ...command,
      // Standalone execution owns the compiler group through verified completion.
      requireProcessTreeExit: process.platform !== "win32",
    });
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code !== "ETIMEDOUT") {
      throw error;
    }
    console.error(
      `[tsgo] no completion after ${command.timeoutMs}ms; killed the tsgo process tree. Raise OPENCLAW_TSGO_TIMEOUT_MS for intentionally longer builds, or unset it to disable the watchdog.`,
    );
    process.exitCode = 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  // Standalone checks serialize with dist consumers; inherited entries reuse their owner.
  await withDistArtifactOwnership(process.cwd(), () => main());
}
