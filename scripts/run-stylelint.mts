// Runs Stylelint through the linked-worktree-aware repository toolchain.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  ensureRepoToolNodeModulesLink,
  resolveRepoToolBinPath,
} from "./lib/local-heavy-check-runtime.mts";

const stylelintPath = resolveRepoToolBinPath("stylelint");
ensureRepoToolNodeModulesLink(stylelintPath);
const result = spawnSync(
  stylelintPath,
  ["--config", path.resolve("config", "stylelint.config.mjs"), ...process.argv.slice(2)],
  { env: process.env, stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
