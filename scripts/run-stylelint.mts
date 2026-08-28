// Runs Stylelint through the linked-worktree-aware repository toolchain.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  ensureRepoToolNodeModulesLink,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";

const stylelintPath = resolveRepoToolBinPath("stylelint");
ensureRepoToolNodeModulesLink(stylelintPath);
const stylelint = createManagedCommandInvocation({
  args: ["--config", path.resolve("config", "stylelint.config.mjs"), ...process.argv.slice(2)],
  bin: stylelintPath,
  env: process.env,
});
const result = spawnSync(stylelint.command, stylelint.args, {
  env: process.env,
  shell: stylelint.shell,
  stdio: "inherit",
  windowsVerbatimArguments: stylelint.windowsVerbatimArguments,
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
