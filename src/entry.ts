#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

function hasExperimentalWarningSuppressed(nodeOptions: string): boolean {
  if (!nodeOptions) return false;
  return (
    nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) ||
    nodeOptions.includes("--no-warnings")
  );
}

function ensureExperimentalWarningSuppressed(): void {
  if (process.env.CLAWDBOT_NODE_OPTIONS_READY === "1") return;
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (hasExperimentalWarningSuppressed(nodeOptions)) return;
  process.env.CLAWDBOT_NODE_OPTIONS_READY = "1";
  process.env.NODE_OPTIONS =
    `${nodeOptions} ${EXPERIMENTAL_WARNING_FLAG}`.trim();
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.signal) process.exit(1);
  process.exit(result.status ?? 1);
}

ensureExperimentalWarningSuppressed();

const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) {
  // Keep it simple; Commander will handle rich help/errors after we strip flags.
  console.error(`[clawdbot] ${parsed.error}`);
  process.exit(2);
}

if (parsed.profile) {
  applyCliProfileEnv({ profile: parsed.profile });
  // Keep Commander and ad-hoc argv checks consistent.
  process.argv = parsed.argv;
}

import("./cli/run-main.js")
  .then(({ runCli }) => runCli(process.argv))
  .catch((error) => {
    console.error(
      "[clawdbot] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
