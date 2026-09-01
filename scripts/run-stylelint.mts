// Runs Stylelint through the linked-worktree-aware repository toolchain.
import path from "node:path";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import {
  ensureRepoToolNodeModulesLink,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

export async function runStylelint(args: string[] = process.argv.slice(2)) {
  const stylelintPath = resolveRepoToolBinPath("stylelint");
  ensureRepoToolNodeModulesLink(stylelintPath);
  return await runManagedCommand({
    args: ["--config", path.resolve("config", "stylelint.config.mjs"), ...args],
    bin: stylelintPath,
    env: process.env,
    requireProcessTreeExit: process.platform !== "win32",
  });
}

if (import.meta.main) {
  await runWithFailedTrailer("stylelint", async () => {
    process.exitCode = await runStylelint();
  });
}
