// Runs the complete lint pipeline after preparing a linked-worktree toolchain.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import {
  ensureRepoToolNodeModulesLink,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { main as runOxlintShards } from "./run-oxlint-shards.mts";
import { runStylelint } from "./run-stylelint.mts";

await runWithFailedTrailer("lint", async () => {
  const oxlintPath = resolveRepoToolBinPath("oxlint");
  const tsxPath = resolveRepoToolBinPath("tsx");
  ensureRepoToolNodeModulesLink(oxlintPath);
  const tsxImportSpecifier = pathToFileURL(createRequire(tsxPath).resolve("tsx")).href;

  // Invoke directly: pnpm through a linked node_modules can reconcile its owner's install.
  process.exitCode = await runManagedCommand({
    bin: process.execPath,
    args: [
      "--import",
      tsxImportSpecifier,
      path.resolve("scripts", "control-ui-i18n-verify.ts"),
      "verify",
    ],
    env: process.env,
    requireProcessTreeExit: process.platform !== "win32",
  });
  if (process.exitCode !== 0) {
    return;
  }
  // Compose the batch so cancellation and final reporting remain with this process.
  process.exitCode = await runOxlintShards();
  if (process.exitCode !== 0) {
    return;
  }
  // Oxlint cannot see plain stylesheets or css`` templates in Lit components.
  process.exitCode = await runStylelint([
    "ui/src/**/*.css",
    "ui/src/**/*.ts",
    "ui/public/themes/*.css",
  ]);
});
