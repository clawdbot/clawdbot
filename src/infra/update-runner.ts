import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type CommandOptions, runCommandWithTimeout } from "../process/exec.js";
import { compareSemverStrings } from "./update-check.js";
import { DEV_BRANCH, isBetaTag, isStableTag, type UpdateChannel } from "./update-channels.js";
import { detectGlobalInstallManagerForRoot, globalInstallArgs } from "./update-global.js";
import { trimLogTail } from "./restart-sentinel.js";

export type UpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
};

export type UpdateRunResult = {
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  root?: string;
  reason?: string;
  before?: { sha?: string | null; version?: string | null };
  after?: { sha?: string | null; version?: string | null };
  steps: UpdateStepResult[];
  durationMs: number;
};

type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type UpdateStepInfo = {
  name: string;
  command: string;
  index: number;
  total: number;
};

export type UpdateStepCompletion = UpdateStepInfo & {
  durationMs: number;
  exitCode: number | null;
  stderrTail?: string | null;
};

export type UpdateStepProgress = {
  onStepStart?: (step: UpdateStepInfo) => void;
  onStepComplete?: (step: UpdateStepCompletion) => void;
};

type UpdateRunnerOptions = {
  cwd?: string;
  argv1?: string;
  tag?: string;
  channel?: UpdateChannel;
  timeoutMs?: number;
  runCommand?: CommandRunner;
  progress?: UpdateStepProgress;
};

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_CHARS = 8000;
const PREFLIGHT_MAX_COMMITS = 10;
const START_DIRS = ["cwd", "argv1", "process"];

function normalizeDir(value?: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function resolveNodeModulesBinPackageRoot(argv1: string): string | null {
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) return null;
  if (parts[binIndex - 1] !== "node_modules") return null;
  const binName = path.basename(normalized);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  return path.join(nodeModulesDir, binName);
}

function buildStartDirs(opts: UpdateRunnerOptions): string[] {
  const dirs: string[] = [];
  const cwd = normalizeDir(opts.cwd);
  if (cwd) dirs.push(cwd);
  const argv1 = normalizeDir(opts.argv1);
  if (argv1) {
    dirs.push(path.dirname(argv1));
    const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
    if (packageRoot) dirs.push(packageRoot);
  }
  const proc = normalizeDir(process.cwd());
  if (proc) dirs.push(proc);
  return Array.from(new Set(dirs));
}

async function readPackageVersion(root: string) {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function readBranchName(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
): Promise<string | null> {
  const res = await runCommand(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs,
  }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const branch = res.stdout.trim();
  return branch || null;
}

async function listGitTags(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  pattern = "v*",
): Promise<string[]> {
  const res = await runCommand(["git", "-C", root, "tag", "--list", pattern, "--sort=-v:refname"], {
    timeoutMs,
  }).catch(() => null);
  if (!res || res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveChannelTag(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  channel: Exclude<UpdateChannel, "dev">,
): Promise<string | null> {
  const tags = await listGitTags(runCommand, root, timeoutMs);
  if (channel === "beta") {
    const betaTag = tags.find((tag) => isBetaTag(tag)) ?? null;
    const stableTag = tags.find((tag) => isStableTag(tag)) ?? null;
    if (!betaTag) return stableTag;
    if (!stableTag) return betaTag;
    const cmp = compareSemverStrings(betaTag, stableTag);
    if (cmp != null && cmp < 0) return stableTag;
    return betaTag;
  }
  return tags.find((tag) => isStableTag(tag)) ?? null;
}

async function resolveGitRoot(
  runCommand: CommandRunner,
  candidates: string[],
  timeoutMs: number,
): Promise<string | null> {
  for (const dir of candidates) {
    const res = await runCommand(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      timeoutMs,
    });
    if (res.code === 0) {
      const root = res.stdout.trim();
      if (root) return root;
    }
  }
  return null;
}

async function findPackageRoot(candidates: string[]) {
  for (const dir of candidates) {
    let current = dir;
    for (let i = 0; i < 12; i += 1) {
      const pkgPath = path.join(current, "package.json");
      try {
        const raw = await fs.readFile(pkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed?.name === "clawdbot") return current;
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

async function detectPackageManager(root: string) {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { packageManager?: string };
    const pm = parsed?.packageManager?.split("@")[0]?.trim();
    if (pm === "pnpm" || pm === "bun" || pm === "npm") return pm;
  } catch {
    // ignore
  }

  const files = await fs.readdir(root).catch((): string[] => []);
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  return "npm";
}

type RunStepOptions = {
  runCommand: CommandRunner;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  progress?: UpdateStepProgress;
  stepIndex: number;
  totalSteps: number;
};

async function runStep(opts: RunStepOptions): Promise<UpdateStepResult> {
  const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
  const command = argv.join(" ");

  const stepInfo: UpdateStepInfo = {
    name,
    command,
    index: stepIndex,
    total: totalSteps,
  };

  progress?.onStepStart?.(stepInfo);

  const started = Date.now();
  const result = await runCommand(argv, { cwd, timeoutMs, env });
  const durationMs = Date.now() - started;

  const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);

  progress?.onStepComplete?.({
    ...stepInfo,
    durationMs,
    exitCode: result.code,
    stderrTail,
  });

  return {
    name,
    command,
    cwd,
    durationMs,
    exitCode: result.code,
    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
    stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS),
  };
}

function managerScriptArgs(manager: "pnpm" | "bun" | "npm", script: string, args: string[] = []) {
  if (manager === "pnpm") return ["pnpm", script, ...args];
  if (manager === "bun") return ["bun", "run", script, ...args];
  if (args.length > 0) return ["npm", "run", script, "--", ...args];
  return ["npm", "run", script];
}

function managerInstallArgs(manager: "pnpm" | "bun" | "npm") {
  if (manager === "pnpm") return ["pnpm", "install"];
  if (manager === "bun") return ["bun", "install"];
  return ["npm", "install"];
}

function normalizeTag(tag?: string) {
  const trimmed = tag?.trim();
  if (!trimmed) return "latest";
  return trimmed.startsWith("clawdbot@") ? trimmed.slice("clawdbot@".length) : trimmed;
}

export async function runGatewayUpdate(opts: UpdateRunnerOptions = {}): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const runCommand =
    opts.runCommand ??
    (async (argv, options) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const progress = opts.progress;
  const steps: UpdateStepResult[] = [];
  const candidates = buildStartDirs(opts);

  let stepIndex = 0;
  let gitTotalSteps = 0;

  const step = (
    name: string,
    argv: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): RunStepOptions => {
    const currentIndex = stepIndex;
    stepIndex += 1;
    return {
      runCommand,
      name,
      argv,
      cwd,
      timeoutMs,
      env,
      progress,
      stepIndex: currentIndex,
      totalSteps: gitTotalSteps,
    };
  };

  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) {
    gitRoot = null;
  }

  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-clawdbot-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
    // Get current SHA (not a visible step, no progress)
    const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
      cwd: gitRoot,
      timeoutMs,
    });
    const beforeSha = beforeShaResult.stdout.trim() || null;
    const beforeVersion = await readPackageVersion(gitRoot);
    const channel: UpdateChannel = opts.channel ?? "dev";
    const branch = channel === "dev" ? await readBranchName(runCommand, gitRoot, timeoutMs) : null;
    const needsCheckoutMain = channel === "dev" && branch !== DEV_BRANCH;
    gitTotalSteps = channel === "dev" ? (needsCheckoutMain ? 11 : 10) : 9;

    const statusCheck = await runStep(
      step(
        "clean check",
        ["git", "-C", gitRoot, "status", "--porcelain", "--", ":!dist/control-ui/"],
        gitRoot,
      ),
    );
    steps.push(statusCheck);
    const hasUncommittedChanges =
      statusCheck.stdoutTail && statusCheck.stdoutTail.trim().length > 0;
    if (hasUncommittedChanges) {
      return {
        status: "skipped",
        mode: "git",
        root: gitRoot,
        reason: "dirty",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    if (channel === "dev") {
      if (needsCheckoutMain) {
        const checkoutStep = await runStep(
          step(
            `git checkout ${DEV_BRANCH}`,
            ["git", "-C", gitRoot, "checkout", DEV_BRANCH],
            gitRoot,
          ),
        );
        steps.push(checkoutStep);
        if (checkoutStep.exitCode !== 0) {
          return {
            status: "error",
            mode: "git",
            root: gitRoot,
            reason: "checkout-failed",
            before: { sha: beforeSha, version: beforeVersion },
            steps,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const upstreamStep = await runStep(
        step(
          "upstream check",
          [
            "git",
            "-C",
            gitRoot,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
          ],
          gitRoot,
        ),
      );
      steps.push(upstreamStep);
      if (upstreamStep.exitCode !== 0) {
        return {
          status: "skipped",
          mode: "git",
          root: gitRoot,
          reason: "no-upstream",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const fetchStep = await runStep(
        step("git fetch", ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"], gitRoot),
      );
      steps.push(fetchStep);

      const upstreamShaStep = await runStep(
        step(
          "git rev-parse @{upstream}",
          ["git", "-C", gitRoot, "rev-parse", "@{upstream}"],
          gitRoot,
        ),
      );
      steps.push(upstreamShaStep);
      const upstreamSha = upstreamShaStep.stdoutTail?.trim();
      if (!upstreamShaStep.stdoutTail || !upstreamSha) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "no-upstream-sha",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const revListStep = await runStep(
        step(
          "git rev-list",
          ["git", "-C", gitRoot, "rev-list", `--max-count=${PREFLIGHT_MAX_COMMITS}`, upstreamSha],
          gitRoot,
        ),
      );
      steps.push(revListStep);
      if (revListStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "preflight-revlist-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const candidates = (revListStep.stdoutTail ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (candidates.length === 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "preflight-no-candidates",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const manager = await detectPackageManager(gitRoot);
      const preflightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-update-preflight-"));
      const worktreeDir = path.join(preflightRoot, "worktree");
      const worktreeStep = await runStep(
        step(
          "preflight worktree",
          ["git", "-C", gitRoot, "worktree", "add", "--detach", worktreeDir, upstreamSha],
          gitRoot,
        ),
      );
      steps.push(worktreeStep);
      if (worktreeStep.exitCode !== 0) {
        await fs.rm(preflightRoot, { recursive: true, force: true }).catch(() => {});
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "preflight-worktree-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      let selectedSha: string | null = null;
      try {
        for (const sha of candidates) {
          const shortSha = sha.slice(0, 8);
          const checkoutStep = await runStep(
            step(
              `preflight checkout (${shortSha})`,
              ["git", "-C", worktreeDir, "checkout", "--detach", sha],
              worktreeDir,
            ),
          );
          steps.push(checkoutStep);
          if (checkoutStep.exitCode !== 0) continue;

          const depsStep = await runStep(
            step(`preflight deps install (${shortSha})`, managerInstallArgs(manager), worktreeDir),
          );
          steps.push(depsStep);
          if (depsStep.exitCode !== 0) continue;

          const lintStep = await runStep(
            step(`preflight lint (${shortSha})`, managerScriptArgs(manager, "lint"), worktreeDir),
          );
          steps.push(lintStep);
          if (lintStep.exitCode !== 0) continue;

          const buildStep = await runStep(
            step(`preflight build (${shortSha})`, managerScriptArgs(manager, "build"), worktreeDir),
          );
          steps.push(buildStep);
          if (buildStep.exitCode !== 0) continue;

          selectedSha = sha;
          break;
        }
      } finally {
        const removeStep = await runStep(
          step(
            "preflight cleanup",
            ["git", "-C", gitRoot, "worktree", "remove", "--force", worktreeDir],
            gitRoot,
          ),
        );
        steps.push(removeStep);
        await runCommand(["git", "-C", gitRoot, "worktree", "prune"], {
          cwd: gitRoot,
          timeoutMs,
        }).catch(() => null);
        await fs.rm(preflightRoot, { recursive: true, force: true }).catch(() => {});
      }

      if (!selectedSha) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "preflight-no-good-commit",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const rebaseStep = await runStep(
        step("git rebase", ["git", "-C", gitRoot, "rebase", selectedSha], gitRoot),
      );
      steps.push(rebaseStep);
      if (rebaseStep.exitCode !== 0) {
        const abortResult = await runCommand(["git", "-C", gitRoot, "rebase", "--abort"], {
          cwd: gitRoot,
          timeoutMs,
        });
        steps.push({
          name: "git rebase --abort",
          command: "git rebase --abort",
          cwd: gitRoot,
          durationMs: 0,
          exitCode: abortResult.code,
          stdoutTail: trimLogTail(abortResult.stdout, MAX_LOG_CHARS),
          stderrTail: trimLogTail(abortResult.stderr, MAX_LOG_CHARS),
        });
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "rebase-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
    } else {
      const fetchStep = await runStep(
        step("git fetch", ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"], gitRoot),
      );
      steps.push(fetchStep);
      if (fetchStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "fetch-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const tag = await resolveChannelTag(runCommand, gitRoot, timeoutMs, channel);
      if (!tag) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "no-release-tag",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const checkoutStep = await runStep(
        step(`git checkout ${tag}`, ["git", "-C", gitRoot, "checkout", "--detach", tag], gitRoot),
      );
      steps.push(checkoutStep);
      if (checkoutStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "checkout-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const manager = await detectPackageManager(gitRoot);

    const depsStep = await runStep(step("deps install", managerInstallArgs(manager), gitRoot));
    steps.push(depsStep);

    const buildStep = await runStep(step("build", managerScriptArgs(manager, "build"), gitRoot));
    steps.push(buildStep);

    const uiBuildStep = await runStep(
      step("ui:build", managerScriptArgs(manager, "ui:build"), gitRoot),
    );
    steps.push(uiBuildStep);

    // Restore dist/control-ui/ to committed state to prevent dirty repo after update
    // (ui:build regenerates assets with new hashes, which would block future updates)
    const restoreUiStep = await runStep(
      step(
        "restore control-ui",
        ["git", "-C", gitRoot, "checkout", "--", "dist/control-ui/"],
        gitRoot,
      ),
    );
    steps.push(restoreUiStep);

    const doctorStep = await runStep(
      step(
        "clawdbot doctor",
        managerScriptArgs(manager, "clawdbot", ["doctor", "--non-interactive"]),
        gitRoot,
        { CLAWDBOT_UPDATE_IN_PROGRESS: "1" },
      ),
    );
    steps.push(doctorStep);

    const failedStep = steps.find((s) => s.exitCode !== 0);
    const afterShaStep = await runStep(
      step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    steps.push(afterShaStep);
    const afterVersion = await readPackageVersion(gitRoot);

    return {
      status: failedStep ? "error" : "ok",
      mode: "git",
      root: gitRoot,
      reason: failedStep ? failedStep.name : undefined,
      before: { sha: beforeSha, version: beforeVersion },
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: afterVersion,
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      reason: `no root (${START_DIRS.join(",")})`,
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
  if (globalManager) {
    const spec = `clawdbot@${normalizeTag(opts.tag)}`;
    const updateStep = await runStep({
      runCommand,
      name: "global update",
      argv: globalInstallArgs(globalManager, spec),
      cwd: pkgRoot,
      timeoutMs,
      progress,
      stepIndex: 0,
      totalSteps: 1,
    });
    const steps = [updateStep];
    const afterVersion = await readPackageVersion(pkgRoot);
    return {
      status: updateStep.exitCode === 0 ? "ok" : "error",
      mode: globalManager,
      root: pkgRoot,
      reason: updateStep.exitCode === 0 ? undefined : updateStep.name,
      before: { version: beforeVersion },
      after: { version: afterVersion },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    status: "skipped",
    mode: "unknown",
    root: pkgRoot,
    reason: "not-git-install",
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}
