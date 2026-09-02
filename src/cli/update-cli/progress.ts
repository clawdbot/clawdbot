// Update command presentation helpers: spinner lifecycle, failure hints, and result summaries.
import { spinner } from "@clack/prompts";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  formatDurationCompact,
  formatDurationPrecise,
} from "../../infra/format-time/format-duration.ts";
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

/** Convert updater failure reasons and stderr tails into operator-facing recovery hints. */
function inferUpdateFailureHints(result: UpdateRunResult): string[] {
  if (result.status !== "error") {
    return [];
  }
  if (result.reason === "preflight-insufficient-space") {
    return [
      "Free space on the preflight staging and package-manager store filesystems, then rerun the update.",
      "Preflight stopped because storage was exhausted; trying another commit would not repair it.",
    ];
  }
  if (result.reason === "pnpm-corepack-missing") {
    return [
      "This pnpm checkout could not auto-enable pnpm because corepack is missing.",
      "Install pnpm manually or install Node with corepack available, then rerun the update command.",
    ];
  }
  if (result.reason === "pnpm-corepack-enable-failed") {
    return [
      "This pnpm checkout could not auto-enable pnpm via corepack.",
      "Run `corepack enable` manually or install pnpm manually, then rerun the update command.",
    ];
  }
  if (result.reason === "pnpm-npm-bootstrap-failed") {
    return [
      "This pnpm checkout could not bootstrap pnpm from npm automatically.",
      "Install pnpm manually, then rerun the update command.",
    ];
  }
  if (result.reason === "preferred-manager-unavailable") {
    return [
      "This checkout requires its declared package manager and the updater could not find it.",
      "Install the missing package manager manually, then rerun the update command.",
    ];
  }
  if (result.mode !== "npm") {
    return [];
  }
  const failedStep = [...result.steps].toReversed().find((step) => step.exitCode !== 0);
  if (!failedStep) {
    return [];
  }

  const stderr = normalizeLowercaseStringOrEmpty(failedStep.stderrTail);
  const hints: string[] = [];
  const isGlobalPackageInstallStep =
    failedStep.name.startsWith("global update") || failedStep.name.startsWith("global install");

  if (isGlobalPackageInstallStep && stderr.includes("eacces")) {
    hints.push(
      "Detected permission failure (EACCES). Re-run with a writable global prefix or sudo (for system-managed Node installs).",
    );
    hints.push(
      "If you recover with sudo/manual package install on a managed Gateway, stop the Gateway first so it does not load files while the package tree is being replaced.",
    );
    hints.push("Example: npm config set prefix ~/.local && npm i -g openclaw@latest");
    hints.push(
      "System install outline: openclaw gateway stop -> sudo <system-npm> i -g openclaw@latest -> openclaw gateway install --force -> openclaw gateway restart.",
    );
  }

  if (
    failedStep.name.startsWith("global update") &&
    (stderr.includes("node-gyp") || stderr.includes("prebuild"))
  ) {
    hints.push(
      "Detected native optional dependency build failure. The updater retries with --omit=optional automatically.",
    );
    hints.push("If it still fails: npm i -g openclaw@latest --omit=optional");
  }

  return hints;
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

type PrintResultOptions = UpdateCommandOptions & {
  hideSteps?: boolean;
};

/** Render a completed updater run as JSON or terminal output. */
export function printResult(result: UpdateRunResult, opts: PrintResultOptions): void {
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }

  const statusColor =
    result.status === "ok" ? theme.success : result.status === "skipped" ? theme.warn : theme.error;

  defaultRuntime.log("");
  defaultRuntime.log(
    `${theme.heading("Update Result:")} ${statusColor(result.status.toUpperCase())}`,
  );
  if (result.root) {
    defaultRuntime.log(`  Root: ${theme.muted(result.root)}`);
  }
  if (result.reason) {
    defaultRuntime.log(`  Reason: ${theme.muted(result.reason)}`);
  }

  if (result.before?.version || result.before?.sha) {
    const before = result.before.version ?? result.before.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  Before: ${theme.muted(before)}`);
  }
  if (result.after?.version || result.after?.sha) {
    const after = result.after.version ?? result.after.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  After: ${theme.muted(after)}`);
  }

  // Some preflight failures are synthesized without a progress callback. Keep
  // their diagnostics visible even when successful streamed steps are hidden.
  const steps = opts.hideSteps
    ? result.steps.filter((step) => step.exitCode !== 0 || isAdvisoryStep(step))
    : result.steps;
  if (steps.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Steps:"));
    for (const step of steps) {
      printStep(step);
    }
  }

  const hints = inferUpdateFailureHints(result);
  if (hints.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Recovery hints:"));
    for (const hint of hints) {
      defaultRuntime.log(`  - ${theme.warn(hint)}`);
    }
  }

  defaultRuntime.log("");
  const totalTime =
    result.durationMs < 60_000
      ? formatDurationPrecise(result.durationMs)
      : (formatDurationCompact(result.durationMs, { spaced: true }) ?? "0ms");
  defaultRuntime.log(`Total time: ${theme.muted(totalTime)}`);
}
