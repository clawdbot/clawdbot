#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses an installed actionlint when present, otherwise falls back to `go run`
// for the pinned version used by CI, then runs repo-specific composite guards.
import { spawnSync } from "node:child_process";

const ACTIONLINT_VERSION = "1.7.11";

function commandExists(command) {
  return spawnSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (commandExists("actionlint")) {
  run("actionlint", []);
} else {
  run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`]);
}

run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
run("node", ["scripts/check-no-conflict-markers.mjs"]);
