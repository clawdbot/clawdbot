#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses installed tools when present, otherwise falls back to pinned hooks where
// possible, then runs repo-specific workflow guards.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ACTIONLINT_VERSION = "1.7.11";
const WORKFLOW_DIR = ".github/workflows";

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

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted()
    .map((file) => join(WORKFLOW_DIR, file));
}

function runPreCommitHook(hook, files) {
  const hookArgs = ["run", "--config", ".pre-commit-config.yaml", hook, "--files", ...files];
  if (commandExists("pre-commit")) {
    run("pre-commit", hookArgs);
    return;
  }
  if (commandExists("python3", ["-m", "pre_commit", "--version"])) {
    run("python3", ["-m", "pre_commit", ...hookArgs]);
    return;
  }

  console.error(
    `[check-workflows] missing pre-commit runtime for ${hook}: install pre-commit or python3 pre_commit.`,
  );
  process.exit(1);
}

const workflows = workflowFiles();

if (commandExists("actionlint")) {
  run("actionlint", workflows);
} else if (commandExists("go", ["version"])) {
  run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`]);
} else if (
  commandExists("pre-commit") ||
  commandExists("python3", ["-m", "pre_commit", "--version"])
) {
  runPreCommitHook("actionlint", workflows);
} else {
  console.error(
    `[check-workflows] missing workflow linter: install actionlint, Go ${ACTIONLINT_VERSION} fallback support, or pre-commit.`,
  );
  process.exit(1);
}

runPreCommitHook("zizmor", workflows);

run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
run("node", ["scripts/check-no-conflict-markers.mjs"]);
