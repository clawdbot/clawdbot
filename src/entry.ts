#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

const EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

function hasExperimentalWarningSuppressed(nodeOptions: string): boolean {
  if (!nodeOptions) return false;
  return nodeOptions.includes(EXPERIMENTAL_WARNING_FLAG) || nodeOptions.includes("--no-warnings");
}

function ensureExperimentalWarningSuppressed(): boolean {
  if (process.env.CLAWDBOT_NODE_OPTIONS_READY === "1") return false;
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (hasExperimentalWarningSuppressed(nodeOptions)) return false;

  process.env.CLAWDBOT_NODE_OPTIONS_READY = "1";
  process.env.NODE_OPTIONS = `${nodeOptions} ${EXPERIMENTAL_WARNING_FLAG}`.trim();

  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });

  attachChildProcessBridge(child);

  child.once("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
      return;
    }
    process.exit(code ?? 1);
  });

  child.once("error", (error) => {
    console.error(
      "[clawdbot] Failed to respawn CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });

  // Parent must not continue running the CLI.
  return true;
}

if (!ensureExperimentalWarningSuppressed()) {
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
}
