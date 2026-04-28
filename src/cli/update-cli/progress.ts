import { spinner } from "@clack/prompts";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import type {
  UpdateRunResult,
  UpdateStepInfo,
  UpdateStepProgress,
} from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";
import type { UpdateCommandOptions } from "./shared.js";

const STEP_LABELS: Record<string, string> = {
  "clean check": "Working directory is clean",
  "upstream check": "Upstream branch exists",
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
};

function getStepLabel(step: UpdateStepInfo): string {
  return STEP_LABELS[step.name] ?? step.name;
}

export function inferUpdateFailureHints(result: UpdateRunResult): string[] {
  if (result.status !== "error") {
    return [];
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
    hints.push("Example: npm config set prefix ~/.local && npm i -g openclaw@latest");
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

export type ProgressController = {
  progress: UpdateStepProgress;
  stop: () => void;
};

export function createUpdateProgress(enabled: boolean): ProgressController {
  if (!enabled) {
    return {
      progress: {},
      stop: () => {},
    };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;

  const progress: UpdateStepProgress = {
    onStepStart: (step) => {
      currentSpinner = spinner();
      currentSpinner.start(theme.accent(getStepLabel(step)));
    },
    onStepComplete: (step) => {
      if (!currentSpinner) {
        return;
      }

      const label = getStepLabel(step);
      const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
      const icon = step.exitCode === 0 ? theme.success("\u2713") : theme.error("\u2717");

      currentSpinner.stop(`${icon} ${label} ${duration}`);
      currentSpinner = null;

      if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(-10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.error(line)}`);
          }
        }
      }
    },
  };

  return {
    progress,
    stop: () => {
      if (currentSpinner) {
        currentSpinner.stop();
        currentSpinner = null;
      }
    },
  };
}

function formatStepStatus(exitCode: number | null): string {
  if (exitCode === 0) {
    return theme.success("\u2713");
  }
  if (exitCode === null) {
    return theme.warn("?");
  }
  return theme.error("\u2717");
}

type PrintResultOptions = UpdateCommandOptions & {
  hideSteps?: boolean;
};

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

  if (!opts.hideSteps && result.steps.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Steps:"));
    for (const step of result.steps) {
      const status = formatStepStatus(step.exitCode);
      const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
      defaultRuntime.log(`  ${status} ${step.name} ${duration}`);

      if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.error(line)}`);
          }
        }
      }
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
  defaultRuntime.log(`Total time: ${theme.muted(formatDurationPrecise(result.durationMs))}`);
}
