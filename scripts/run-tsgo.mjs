import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readFlagValue } from "./lib/arg-utils.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mjs";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mjs";

const { args: finalArgs, env } = applyLocalTsgoPolicy(
  process.argv.slice(2),
  resolveLocalHeavyCheckEnv(process.env),
);

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
if (tsBuildInfoFile) {
  fs.mkdirSync(path.dirname(path.resolve(tsBuildInfoFile)), { recursive: true });
}
const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd: process.cwd() });
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
    const result = spawnSync(tsgoPath, finalArgs, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });

    if (result.error) {
      throw result.error;
    }

    process.exitCode = result.status ?? 1;
  }
} finally {
  releaseLock();
}
