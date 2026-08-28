import { hasRawPnpmConfigKey } from "./npm-install-env.js";
import { DEV_BRANCH } from "./update-channels.js";
import type { UpdateStepResult } from "./update-runner-types.js";

const BUILD_MAX_OLD_SPACE_MB = 8192;
const DEV_PREFLIGHT_LINT_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_LOCAL_CHECK: "1",
  OPENCLAW_LOCAL_CHECK_MODE: "throttled",
};
const DEV_PREFLIGHT_LINT_OPT_IN_ENV = "OPENCLAW_UPDATE_PREFLIGHT_LINT";

export function shouldInstallWithoutScriptsOnWindows(manager: "pnpm" | "bun" | "npm"): boolean {
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

export function resolveBuildEnv(
  env?: NodeJS.ProcessEnv,
  buildCacheRoot?: string,
): NodeJS.ProcessEnv | undefined {
  const currentNodeOptions = env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
  const nextNodeOptions = resolveBuildNodeOptions(currentNodeOptions);
  if (nextNodeOptions === currentNodeOptions && !buildCacheRoot) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: nextNodeOptions,
    ...(buildCacheRoot ? { BUILD_ALL_CACHE_ROOT: buildCacheRoot } : {}),
  };
}

export function resolveInstallEnv(
  manager: "pnpm" | "bun" | "npm",
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): NodeJS.ProcessEnv | undefined {
  if (manager !== "pnpm") {
    return env;
  }
  const effectiveEnv = env ?? process.env;
  const hasExplicitPreferOffline =
    effectiveEnv.pnpm_config_prefer_offline !== undefined ||
    effectiveEnv.PNPM_CONFIG_PREFER_OFFLINE !== undefined;
  const hasConfigPreferOffline = hasRawPnpmConfigKey(effectiveEnv, "prefer-offline", {
    npmConfigCwd: cwd,
  });
  const installEnv: NodeJS.ProcessEnv = {
    ...env,
    PNPM_CONFIG_RESOLUTION_MODE: env?.PNPM_CONFIG_RESOLUTION_MODE ?? "highest",
    npm_config_resolution_mode: env?.npm_config_resolution_mode ?? "highest",
    pnpm_config_resolution_mode: env?.pnpm_config_resolution_mode ?? "highest",
  };
  if (!hasExplicitPreferOffline && !hasConfigPreferOffline) {
    installEnv.PNPM_CONFIG_PREFER_OFFLINE = "true";
    installEnv.pnpm_config_prefer_offline = "true";
  }
  return installEnv;
}

function isSupersededInstallFailure(
  step: UpdateStepResult,
  steps: readonly UpdateStepResult[],
): boolean {
  return (
    step.name === "deps install" &&
    steps.some(
      (candidate) => candidate.name === "deps install (ignore scripts)" && candidate.exitCode === 0,
    )
  );
}

function isPreflightCandidateFailure(step: UpdateStepResult): boolean {
  return /^preflight (?:checkout|package manager|deps install(?: \(ignore scripts\))?|build|config validate|lint) \(.+\)$/u.test(
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
