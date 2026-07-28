// Runs the complete lint pipeline after preparing a linked-worktree toolchain.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureRepoToolNodeModulesLink,
  resolveRepoToolBinPath,
} from "./lib/local-heavy-check-runtime.mjs";

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

const oxlintPath = resolveRepoToolBinPath("oxlint");
const tsxPath = resolveRepoToolBinPath("tsx");
ensureRepoToolNodeModulesLink(oxlintPath);
const tsxImportSpecifier = pathToFileURL(createRequire(tsxPath).resolve("tsx")).href;

// Invoke the pre-step directly: running pnpm through a linked node_modules can
// reconcile the owning checkout's dependency tree instead of merely running it.
const uiI18nStatus = run(
  process.execPath,
  ["--import", tsxImportSpecifier, path.resolve("scripts", "control-ui-i18n-verify.ts"), "verify"],
  { env: process.env, stdio: "inherit" },
);
if (uiI18nStatus !== 0) {
  process.exitCode = uiI18nStatus;
} else {
  const oxlintStatus = run(
    process.execPath,
    [path.resolve("scripts", "run-oxlint-shards.mjs"), ...process.argv.slice(2)],
    { env: process.env, stdio: "inherit" },
  );
  if (oxlintStatus !== 0) {
    process.exitCode = oxlintStatus;
  } else {
    // Control UI CSS hygiene: plain stylesheets plus css`` templates in Lit
    // components. oxlint cannot see inside tagged CSS templates.
    process.exitCode = run(
      resolveRepoToolBinPath("stylelint"),
      [
        "--config",
        path.resolve("config", "stylelint.config.mjs"),
        "ui/src/**/*.css",
        "ui/src/**/*.ts",
      ],
      { env: process.env, stdio: "inherit" },
    );
  }
}
