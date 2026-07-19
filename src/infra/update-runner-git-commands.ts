import { DEV_BRANCH } from "./update-channels.js";
import {
  managerInstallIgnoreScriptsArgs,
  type UpdatePackageManagerFailureReason,
} from "./update-package-manager.js";
import type { UpdateRunResult, UpdateStepResult } from "./update-runner-types.js";

const BUILD_MAX_OLD_SPACE_MB = 8192;
const DEV_PREFLIGHT_LINT_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_LOCAL_CHECK: "1",
  OPENCLAW_LOCAL_CHECK_MODE: "throttled",
  OPENCLAW_OXLINT_SHARDS_SERIAL: "1",
};
const DEV_PREFLIGHT_LINT_OPT_IN_ENV = "OPENCLAW_UPDATE_PREFLIGHT_LINT";

export function mapManagerResolutionFailure(
  reason: UpdatePackageManagerFailureReason,
): NonNullable<UpdateRunResult["reason"]> {
  return reason;
}

export function shouldRetryWindowsInstallIgnoringScripts(manager: "pnpm" | "bun" | "npm"): boolean {
  return process.platform === "win32" && manager === "pnpm";
}

export function shouldPreferIgnoreScriptsForWindowsPreflight(
  manager: "pnpm" | "bun" | "npm",
): boolean {
  return process.platform === "win32" && manager === "pnpm";
}

function resolveBuildNodeOptions(baseOptions: string | undefined): string {
  const current = baseOptions?.trim() ?? "";
  const desired = `--max-old-space-size=${BUILD_MAX_OLD_SPACE_MB}`;
  const existingMatch = /(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)/.exec(current);
  if (!existingMatch) {
    return current ? `${current} ${desired}` : desired;
  }
  const existingValue = Number(existingMatch[1]);
  if (Number.isFinite(existingValue) && existingValue >= BUILD_MAX_OLD_SPACE_MB) {
    return current;
  }
  return current.replace(/(?:^|\s)--max-old-space-size=\d+(?=\s|$)/, ` ${desired}`).trim();
}

export function resolveBuildEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  const currentNodeOptions = env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
  const nextNodeOptions = resolveBuildNodeOptions(currentNodeOptions);
  if (nextNodeOptions === currentNodeOptions) {
    return env;
  }
  return { ...env, NODE_OPTIONS: nextNodeOptions };
}

export function resolveInstallEnv(
  manager: "pnpm" | "bun" | "npm",
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (manager !== "pnpm") {
    return env;
  }
  return {
    ...env,
    PNPM_CONFIG_RESOLUTION_MODE: env?.PNPM_CONFIG_RESOLUTION_MODE ?? "highest",
    npm_config_resolution_mode: env?.npm_config_resolution_mode ?? "highest",
    pnpm_config_resolution_mode: env?.pnpm_config_resolution_mode ?? "highest",
  };
}

function isSupersededInstallFailure(
  step: UpdateStepResult,
  steps: readonly UpdateStepResult[],
): boolean {
  if (step.exitCode === 0) {
    return false;
  }
  if (step.name === "deps install") {
    return steps.some(
      (candidate) => candidate.name === "deps install (ignore scripts)" && candidate.exitCode === 0,
    );
  }
  const preflightMatch = /^preflight deps install \((.+)\)$/.exec(step.name);
  if (!preflightMatch) {
    return false;
  }
  const retryName = `preflight deps install (ignore scripts) (${preflightMatch[1]})`;
  return steps.some((candidate) => candidate.name === retryName && candidate.exitCode === 0);
}

function isPreflightCandidateFailure(step: UpdateStepResult): boolean {
  return /^preflight (?:checkout|package manager|deps install(?: \(ignore scripts\))?|build|lint) \(.+\)$/u.test(
    step.name,
  );
}

function isSupersededTargetRefFailure(
  step: UpdateStepResult,
  followingSteps: readonly UpdateStepResult[],
): boolean {
  const isTargetRefProbe = step.name.startsWith("git rev-parse ");
  const isTargetTagFetch = step.name.startsWith("git fetch ") && step.name.includes(" refs/tags/");
  const isUpstreamProbe = step.name === "upstream check";
  const isLocalDevBranchProbe = step.name === `git show-ref ${DEV_BRANCH}`;
  if (!isTargetRefProbe && !isTargetTagFetch && !isUpstreamProbe && !isLocalDevBranchProbe) {
    return false;
  }
  if (isLocalDevBranchProbe) {
    return followingSteps.some(
      (candidate) =>
        candidate.name.startsWith(`git checkout -B ${DEV_BRANCH} `) && candidate.exitCode === 0,
    );
  }
  return followingSteps.some(
    (candidate) => candidate.name.startsWith("git rev-parse ") && candidate.exitCode === 0,
  );
}

export function findBlockingGitFailure(
  steps: readonly UpdateStepResult[],
): UpdateStepResult | undefined {
  return steps.find(
    (step, index) =>
      step.exitCode !== 0 &&
      !isPreflightCandidateFailure(step) &&
      !isSupersededInstallFailure(step, steps) &&
      !isSupersededTargetRefFailure(step, steps.slice(index + 1)),
  );
}

export function shouldRunDevPreflightLint(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DEV_PREFLIGHT_LINT_OPT_IN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function resolveDevPreflightLintEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...env, ...DEV_PREFLIGHT_LINT_ENV };
}

export function resolveRetryInstallArgs(manager: "pnpm" | "bun" | "npm") {
  return managerInstallIgnoreScriptsArgs(manager);
}
