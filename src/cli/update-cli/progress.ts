// Update command presentation helpers: spinner lifecycle, failure hints, and result summaries.
import { spinner } from "@clack/prompts";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type {
  UpdateRunResult,
  UpdateStepAdvisory,
  UpdateStepInfo,
  UpdateStepProgress,
  UpdateStepResult,
} from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";

const STEP_LABELS: Record<string, string> = {
  "clean check": "Checking for local changes",
  "upstream check": "Checking the upstream branch",
  "git fetch": "Fetching latest changes",
  "git rebase": "Rebasing onto target commit",
  "git rev-parse @{upstream}": "Resolving upstream commit",
  "git rev-list": "Enumerating candidate commits",
  "git clone": "Cloning git checkout",
  "preflight worktree": "Preparing preflight worktree",
  "preflight cleanup": "Cleaning preflight worktree",
  "deps install": "Installing dependencies",
  build: "Building",
  "ui:build": "Building UI assets",
  "ui:build (post-doctor repair)": "Restoring missing UI assets",
  "ui assets verify": "Validating UI assets",
  "openclaw doctor entry": "Checking doctor entrypoint",
  "openclaw doctor": "Running doctor checks",
  "git rev-parse HEAD (after)": "Verifying update",
  "global update": "Updating via package manager",
  "global update (omit optional)": "Retrying update without optional deps",
  "global install stage": "Preparing staged package install",
  "global install verify": "Verifying global package",
  "global install swap": "Activating global package",
  "global install": "Installing global package",
  "global update pack": "Downloading the update",
  "global update pack verify": "Verifying the downloaded package",
  checkout: "Checking out candidate",
  lint: "Checking code quality",
  "config validate": "Validating configuration",
};

function getStepLabel(step: Pick<UpdateStepInfo, "name">): string {
  return (
    STEP_LABELS[step.name] ??
    step.name.replace(
      /^preflight (.+) \(([a-f0-9]+)\)$/,
      (_match, name: string, sha: string) => `Preflight: ${STEP_LABELS[name] ?? name} (${sha})`,
    )
  );
}

function isAdvisoryStep(step: { advisory?: UpdateStepAdvisory }): boolean {
  return step.advisory !== undefined;
}

/** Runner-facing progress callbacks plus terminal spinner cleanup. */
type ProgressController = {
  progress: UpdateStepProgress;
  stop: () => void;
};

/** Create a progress adapter for the updater runner without coupling runner code to terminal UI. */
export function createUpdateProgress(enabled: boolean): ProgressController {
  if (!enabled) {
    return {
      progress: {},
      stop: () => {},
    };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;
  const stop = () => {
    currentSpinner?.clear();
    currentSpinner = null;
  };

  const progress: UpdateStepProgress = {
    onStepStart: (step) => {
      stop();
      if (process.stdout.isTTY) {
        currentSpinner = spinner({ indicator: "timer" });
        currentSpinner.start(theme.accent(getStepLabel(step)));
      } else {
        defaultRuntime.log(`${getStepLabel(step)}...`);
      }
    },
    onStepComplete: (step) => {
      stop();
      printStep(step);
    },
  };

  return { progress, stop };
}

type DisplayStep = Pick<
  UpdateStepResult,
  | "name"
  | "durationMs"
  | "exitCode"
  | "advisory"
  | "stdoutTail"
  | "stderrTail"
  | "termination"
  | "signal"
>;

function printStep(step: DisplayStep): void {
  const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
  const termination =
    step.termination === "timeout" || step.termination === "no-output-timeout"
      ? " — timed out"
      : step.signal
        ? ` — interrupted (${step.signal})`
        : "";
  defaultRuntime.log(`  ${formatStepStatus(step)} ${getStepLabel(step)}${termination} ${duration}`);
  if (!isAdvisoryStep(step) && step.exitCode === 0) {
    return;
  }
  // Build tools often report failures on stdout. Keep the final diagnostic from
  // each stream, so npm's stderr footer cannot hide the actual build error.
  const color = isAdvisoryStep(step) ? theme.warn : theme.error;
  for (const output of [step.stdoutTail, step.stderrTail]) {
    for (const line of (output ?? "").trimEnd().split("\n").slice(-10)) {
      if (line.trim()) {
        defaultRuntime.log(`    ${color(line)}`);
      }
    }
  }
}

function formatStepStatus(step: {
  exitCode: number | null;
  advisory?: UpdateStepAdvisory;
}): string {
  if (isAdvisoryStep(step)) {
    return theme.warn("!");
  }
  if (step.exitCode === 0) {
    return theme.success("\u2713");
  }
  if (step.exitCode === null) {
    return theme.warn("?");
  }
  return theme.error("\u2717");
}

/** Render a completed updater run as JSON or terminal output. */
export function printResult(
  result: UpdateRunResult,
  opts: UpdateCommandOptions,
  reportHints: { doctorHint?: string | null; nextAction?: string } = {},
): void {
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }

  const run = result.runId ? getUpdateRun(result.runId, { env: opts.run?.env }) : undefined;
  const report = renderUpdateRunReport(run ?? updateRunReportInputFromResult(result), reportHints);
  defaultRuntime.log("");
  defaultRuntime.log(theme.heading(report.headline));
  for (const line of report.lines) {
    defaultRuntime.log(line);
  }
}
