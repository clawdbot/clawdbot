// Runs tsgo through local heavy-check policy and sparse-checkout guards.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFlagValue } from "./lib/arg-utils.mts";
import {
  createWrapperProof,
  type WrapperProof,
  writeWrapperProofReceipt,
} from "./lib/check-proof-reuse.mts";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  ensureRepoToolNodeModulesLink,
  resolveLocalHeavyCheckEnv,
  resolveRepoToolBinPath,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mts";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mts";

type TsgoWrapperProofPlan = {
  args: string[];
  env: NodeJS.ProcessEnv;
  proof: WrapperProof;
  sparseGuardError: string | null;
};

export function createTsgoWrapperProofForArgs(
  argv: string[],
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  options: {
    cwd?: string;
    hostResources?: { logicalCpuCount: number; totalMemoryBytes: number };
  } = {},
): TsgoWrapperProofPlan {
  const cwd = options.cwd ?? process.cwd();
  const hostResources = options.hostResources ?? {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const { args, env } = applyLocalTsgoPolicy(
    argv,
    resolveLocalHeavyCheckEnv(runtimeEnv),
    hostResources,
  );
  return {
    args,
    env,
    proof: createWrapperProof({
      tool: "tsgo",
      wrapper: "scripts/run-tsgo.mts",
      argv: args,
      cwd,
    }),
    sparseGuardError: getSparseTsgoGuardError(args, { cwd }),
  };
}

function main(): void {
  const proofReceiptPath = process.env.OPENCLAW_TOOL_PROOF_RECEIPT;
  const hostResources = {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const {
    args: finalArgs,
    env,
    proof,
    sparseGuardError,
  } = createTsgoWrapperProofForArgs(process.argv.slice(2), process.env, { hostResources });

  const tsgoPath = resolveRepoToolBinPath("tsgo");
  const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
  if (tsBuildInfoFile) {
    fs.mkdirSync(path.dirname(path.resolve(tsBuildInfoFile)), { recursive: true });
  }
  const releaseLock =
    sparseGuardError ||
    env.OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD === "1" ||
    !shouldAcquireLocalHeavyCheckLockForTsgo(finalArgs, env)
      ? () => {}
      : acquireLocalHeavyCheckLockSync({
          cwd: process.cwd(),
          env,
          toolName: "tsgo",
        });

  try {
    if (sparseGuardError) {
      console.error(sparseGuardError);
      if (shouldSkipSparseTsgoGuardError(env)) {
        console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
        process.exitCode = 0;
      } else {
        process.exitCode = 1;
      }
    } else {
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
      if (process.exitCode === 0) {
        writeWrapperProofReceipt(proofReceiptPath, proof);
      }
    }
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  main();
}
