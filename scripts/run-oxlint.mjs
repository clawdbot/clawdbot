import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";

const { args: finalArgs, env } = applyLocalOxlintPolicy(process.argv.slice(2), process.env);

const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
const releaseLock = shouldAcquireLocalHeavyCheckLockForOxlint(finalArgs, {
  cwd: process.cwd(),
  env,
})
  ? acquireLocalHeavyCheckLockSync({
      cwd: process.cwd(),
      env,
      toolName: "oxlint",
    })
  : () => {};

try {
  const result = spawnSync(oxlintPath, finalArgs, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} finally {
  releaseLock();
}
