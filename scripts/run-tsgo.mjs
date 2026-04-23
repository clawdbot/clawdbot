import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mjs";
import { getSparseTsgoGuardError } from "./lib/tsgo-sparse-guard.mjs";

const { args: finalArgs, env } = applyLocalTsgoPolicy(process.argv.slice(2), process.env);

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
if (tsBuildInfoFile) {
  fs.mkdirSync(path.dirname(path.resolve(tsBuildInfoFile)), { recursive: true });
}
const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd: process.cwd() });
const releaseLock =
  sparseGuardError || !shouldAcquireLocalHeavyCheckLockForTsgo(finalArgs, env)
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env,
        toolName: "tsgo",
      });

try {
  if (sparseGuardError) {
    console.error(sparseGuardError);
    process.exitCode = 1;
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

function readFlagValue(args, name) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}
