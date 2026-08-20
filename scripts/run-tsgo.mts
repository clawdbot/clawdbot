// Runs tsgo through local resource policy and sparse-checkout guards.
import { spawnSync } from "node:child_process";
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
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mts";

function main(): void {
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
  const tsgo = createManagedCommandInvocation({
    args: finalArgs,
    bin: tsgoPath,
    env,
  });
  const result = spawnSync(tsgo.command, tsgo.args, {
    stdio: "inherit",
    env,
    shell: tsgo.shell,
    windowsVerbatimArguments: tsgo.windowsVerbatimArguments,
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}

if (import.meta.main) {
  main();
}
