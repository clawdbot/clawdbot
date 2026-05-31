#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses an installed actionlint when present, otherwise falls back to `go run`
// for the pinned version used by CI, then runs repo-specific composite guards.
import { spawnSync } from "node:child_process";

const ACTIONLINT_VERSION = "1.7.11";

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`[check-workflows] failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (commandExists("actionlint")) {
  run("actionlint", []);
} else if (commandExists("go", ["version"])) {
  run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`]);
} else {
  console.error(
    `[check-workflows] missing workflow linter: install actionlint or Go ${ACTIONLINT_VERSION} fallback support.`,
  );
  process.exit(1);
}

run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
run("node", ["scripts/check-no-conflict-markers.mjs"]);
