import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { type CommandOptions, runCommandWithTimeout } from "../process/exec.js";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPathForRoot,
} from "./control-ui-assets.js";
import { readPackageName, readPackageVersion } from "./package-json.js";
import { normalizePackageTagInput } from "./package-tag.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { trimLogTail } from "./restart-sentinel.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import {
  channelToNpmTag,
  DEFAULT_PACKAGE_CHANNEL,
  DEV_BRANCH,
  isBetaTag,
  isStableTag,
  type UpdateChannel,
} from "./update-channels.js";
import { compareSemverStrings } from "./update-check.js";
import {
  cleanupGlobalRenameDirs,
  createGlobalInstallEnv,
  detectGlobalInstallManagerForRoot,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
  type GlobalInstallManager,
} from "./update-global.js";
import {
  managerInstallIgnoreScriptsArgs,
  managerInstallArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
  type UpdatePackageManagerFailureReason,
} from "./update-package-manager.js";

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
  postUpdate?: {
    plugins?: {
      status: "ok" | "skipped" | "error";
      reason?: string;
      changed: boolean;
      sync: {
        changed: boolean;
        switchedToBundled: string[];
        switchedToNpm: string[];
        warnings: string[];
        errors: string[];
      };
      npm: {
        changed: boolean;
        outcomes: Array<{
          pluginId: string;
          status: "updated" | "unchanged" | "skipped" | "error";
          message: string;
          currentVersion?: string;
          nextVersion?: string;
        }>;
      };
      integrityDrifts: Array<{
        pluginId: string;
        spec: string;
        expectedIntegrity: string;
        actualIntegrity: string;
        resolvedSpec?: string;
        resolvedVersion?: string;
        action: "aborted";
      }>;
    };
  };
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
  devTargetRef?: string;
  timeoutMs?: number;
  runCommand?: CommandRunner;
  progress?: UpdateStepProgress;
};

export type UpdateInstallSurface =
  | {
      kind: "git";
      mode: "git";
      root: string;
      packageRoot: string;
    }
  | {
      kind: "global";
      mode: GlobalInstallManager;
      root: string;
      packageRoot: string;
    }
  | {
      kind: "package-root";
      mode: "unknown";
      root: string;
      packageRoot: string;
    }
  | {
      kind: "missing";
      mode: "unknown";
      root?: string;
      packageRoot?: undefined;
    };

function mapManagerResolutionFailure(
  reason: UpdatePackageManagerFailureReason,
): UpdateRunResult["reason"] {
  return reason;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_CHARS = 8000;
const PREFLIGHT_MAX_COMMITS = 10;
const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);
const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV =
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
const PREFLIGHT_TEMP_PREFIX =
  process.platform === "win32" ? "ocu-pf-" : "openclaw-update-preflight-";
const PREFLIGHT_WORKTREE_DIRNAME = process.platform === "win32" ? "wt" : "worktree";
const PREFLIGHT_CLEANUP_TIMEOUT_MS = 60_000;
const WINDOWS_PREFLIGHT_BASE_DIR = "ocu";
const WINDOWS_BUILD_MAX_OLD_SPACE_MB = 4096;

function normalizeDir(value?: string | null) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function resolveNodeModulesBinPackageRoot(argv1: string): string | null {
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) {
    return null;
  }
  if (parts[binIndex - 1] !== "node_modules") {
    return null;
  }
  const binName = path.basename(normalized);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  return path.join(nodeModulesDir, binName);
}

function buildStartDirs(opts: UpdateRunnerOptions): string[] {
  const dirs: string[] = [];
  const cwd = normalizeDir(opts.cwd);
  if (cwd) {
    dirs.push(cwd);
  }
  const argv1 = normalizeDir(opts.argv1);
  if (argv1) {
    dirs.push(path.dirname(argv1));
    const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
    if (packageRoot) {
      dirs.push(packageRoot);
    }
  }
  const proc = normalizeDir(process.cwd());
  if (proc) {
    dirs.push(proc);
  }
  return Array.from(new Set(dirs));
}

function resolvePreflightTempRootPrefix() {
  return path.join(os.tmpdir(), PREFLIGHT_TEMP_PREFIX);
}

function resolvePreflightWorktreeDir(preflightRoot: string) {
  return path.join(preflightRoot, PREFLIGHT_WORKTREE_DIRNAME);
}

function shouldUseNativeWindowsTempRoot() {
  return process.platform === "win32" && path.sep === "\\";
}

async function createPreflightRoot() {
  if (shouldUseNativeWindowsTempRoot()) {
    const baseDir = path.win32.join(process.env.SystemDrive ?? "C:", WINDOWS_PREFLIGHT_BASE_DIR);
    await fs.mkdir(baseDir, { recursive: true });
    return fs.mkdtemp(path.win32.join(baseDir, PREFLIGHT_TEMP_PREFIX));
  }
  return fs.mkdtemp(resolvePreflightTempRootPrefix());
}

async function removePathRecursive(target: string) {
  await fs
    .rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    .catch(() => {});
}

async function repairPreflightCleanup(worktreeDir: string, preflightRoot: string) {
  try {
    await fs.rm(worktreeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await fs.rm(preflightRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return true;
  } catch {
    return false;
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
  if (!res || res.code !== 0) {
    return null;
  }
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
  if (!res || res.code !== 0) {
    return [];
  }
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
    if (!betaTag) {
      return stableTag;
    }
    if (!stableTag) {
      return betaTag;
    }
    const cmp = compareSemverStrings(betaTag, stableTag);
    if (cmp != null && cmp < 0) {
      return stableTag;
    }
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
    }).catch(() => null);
    if (!res) {
      continue;
    }
    if (res.code === 0) {
      const root = res.stdout.trim();
      if (root) {
        return root;
      }
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
        const name = parsed?.name?.trim();
        if (name && CORE_PACKAGE_NAMES.has(name)) {
          return current;
        }
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
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

function normalizeTag(tag?: string) {
  return normalizePackageTagInput(tag, ["openclaw", DEFAULT_PACKAGE_NAME]) ?? "latest";
}

function normalizeDevTargetRef(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function looksLikeFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value.trim());
}

function buildDevTargetRefResolutionCandidates(devTargetRef: string): string[] {
  const trimmed = devTargetRef.trim();
  const candidates: string[] = [];
  const addCandidate = (candidate?: string | null) => {
    if (!candidate || candidates.includes(candidate)) {
      return;
    }
    candidates.push(candidate);
  };

  if (looksLikeFullCommitSha(trimmed)) {
    addCandidate(trimmed);
    return candidates;
  }

  if (trimmed.startsWith("refs/remotes/")) {
    addCandidate(trimmed);
    return candidates;
  }

  if (trimmed.startsWith("refs/heads/")) {
    addCandidate(`refs/remotes/origin/${trimmed.slice("refs/heads/".length)}`);
    return candidates;
  }

  if (trimmed.startsWith("origin/")) {
    addCandidate(`refs/remotes/${trimmed}`);
    return candidates;
  }

  if (trimmed.startsWith("refs/tags/")) {
    addCandidate(`${trimmed}^{}`);
    addCandidate(trimmed);
    return candidates;
  }

  // Resolve plain branch names from the freshly fetched remote ref instead of
  // a possibly stale local branch checkout.
  addCandidate(`refs/remotes/origin/${trimmed}`);
  addCandidate(`refs/tags/${trimmed}^{}`);
  addCandidate(`refs/tags/${trimmed}`);
  return candidates;
}

async function resolveComparablePath(target: string): Promise<string> {
  return await fs.realpath(target).catch(() => path.resolve(target));
}

async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  return (await resolveComparablePath(left)) === (await resolveComparablePath(right));
}

async function looksLikeGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

function shouldRetryWindowsInstallIgnoringScripts(manager: "pnpm" | "bun" | "npm"): boolean {
  return process.platform === "win32" && manager === "pnpm";
}

function shouldPreferIgnoreScriptsForWindowsPreflight(manager: "pnpm" | "bun" | "npm"): boolean {
  return process.platform === "win32" && manager === "pnpm";
}

function resolveWindowsBuildNodeOptions(baseOptions: string | undefined): string {
  const current = baseOptions?.trim() ?? "";
  const desired = `--max-old-space-size=${WINDOWS_BUILD_MAX_OLD_SPACE_MB}`;
  const existingMatch = /(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)/.exec(current);
  if (!existingMatch) {
    return current ? `${current} ${desired}` : desired;
  }
  const existingValue = Number(existingMatch[1]);
  if (Number.isFinite(existingValue) && existingValue >= WINDOWS_BUILD_MAX_OLD_SPACE_MB) {
    return current;
  }
  return current.replace(/(?:^|\s)--max-old-space-size=\d+(?=\s|$)/, ` ${desired}`).trim();
}

function resolveWindowsBuildEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "win32") {
    return env;
  }
  const currentNodeOptions = env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
  const nextNodeOptions = resolveWindowsBuildNodeOptions(currentNodeOptions);
  if (nextNodeOptions === currentNodeOptions) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: nextNodeOptions,
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

function findBlockingGitFailure(steps: readonly UpdateStepResult[]): UpdateStepResult | undefined {
  return steps.find((step) => step.exitCode !== 0 && !isSupersededInstallFailure(step, steps));
}

function mergeCommandEnvironments(
  baseEnv: NodeJS.ProcessEnv | undefined,
  overrideEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!baseEnv) {
    return overrideEnv;
  }
  if (!overrideEnv) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ...overrideEnv,
  };
}

function shouldRunDevPreflightLint(): boolean {
  return process.platform !== "win32";
}

function normalizeFallbackFailureReason(stepName: string): NonNullable<UpdateRunResult["reason"]> {
  switch (stepName) {
    case "global update":
    case "global update (omit optional)":
    case "global install stage":
    case "global install verify":
    case "global install swap":
      return "global-install-failed";
    case "openclaw doctor":
      return "doctor-failed";
    case "ui:build (post-doctor repair)":
      return "ui-build-failed";
    default:
      return "unexpected-error";
  }
}

async function buildUpdateCommandRunner(
  runCommand?: CommandRunner,
): Promise<{ defaultCommandEnv: NodeJS.ProcessEnv | undefined; runCommand: CommandRunner }> {
  const defaultCommandEnv = await createGlobalInstallEnv();
  if (runCommand) {
    return {
      defaultCommandEnv,
      runCommand,
    };
  }
  return {
    defaultCommandEnv,
    runCommand: async (argv, options) => {
      const res = await runCommandWithTimeout(argv, {
        ...options,
        env: mergeCommandEnvironments(defaultCommandEnv, options.env),
      });
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    },
  };
}

export async function resolveUpdateInstallSurface(
  opts: Pick<UpdateRunnerOptions, "cwd" | "argv1" | "timeoutMs" | "runCommand"> = {},
): Promise<UpdateInstallSurface> {
  const { runCommand } = await buildUpdateCommandRunner(opts.runCommand);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = buildStartDirs(opts);
  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) {
    gitRoot = null;
  }
  if (gitRoot && !pkgRoot) {
    return {
      kind: "missing",
      mode: "unknown",
      root: gitRoot,
    };
  }
  if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
    return {
      kind: "git",
      mode: "git",
      root: gitRoot,
      packageRoot: pkgRoot,
    };
  }
  if (!pkgRoot) {
    return {
      kind: "missing",
      mode: "unknown",
    };
  }

  const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
  if (globalManager) {
    return {
      kind: "global",
      mode: globalManager,
      root: pkgRoot,
      packageRoot: pkgRoot,
    };
  }

  return {
    kind: "package-root",
    mode: "unknown",
    root: pkgRoot,
    packageRoot: pkgRoot,
  };
}

export async function runGatewayUpdate(opts: UpdateRunnerOptions = {}): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const { defaultCommandEnv, runCommand } = await buildUpdateCommandRunner(opts.runCommand);
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
  if (!gitRoot && pkgRoot) {
    const cwdRoot = normalizeDir(opts.cwd);
    if (
      cwdRoot &&
      (await pathsReferToSameLocation(cwdRoot, pkgRoot)) &&
      (await looksLikeGitCheckout(cwdRoot))
    ) {
      gitRoot = await resolveComparablePath(cwdRoot);
    }
  }
  if (gitRoot && pkgRoot && !(await pathsReferToSameLocation(gitRoot, pkgRoot))) {
    gitRoot = null;
  }

  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-openclaw-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (gitRoot && pkgRoot && (await pathsReferToSameLocation(gitRoot, pkgRoot))) {
    // Get current SHA (not a visible step, no progress)
    const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
      cwd: gitRoot,
      timeoutMs,
    });
    const beforeSha = beforeShaResult.stdout.trim() || null;
    const beforeVersion = await readPackageVersion(gitRoot);
    const channel: UpdateChannel = opts.channel ?? "dev";
    const devTargetRef = channel === "dev" ? normalizeDevTargetRef(opts.devTargetRef) : null;
    const branch = channel === "dev" ? await readBranchName(runCommand, gitRoot, timeoutMs) : null;
    const needsCheckoutMain = channel === "dev" && !devTargetRef && branch !== DEV_BRANCH;
    gitTotalSteps = channel === "dev" ? (needsCheckoutMain ? 11 : 10) : 9;
    const buildGitErrorResult = (reason: string): UpdateRunResult => ({
      status: "error",
      mode: "git",
      root: gitRoot,
      reason,
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startedAt,
    });
    const runGitCheckoutOrFail = async (name: string, argv: string[]) => {
      const checkoutStep = await runStep(step(name, argv, gitRoot));
      steps.push(checkoutStep);
      if (checkoutStep.exitCode !== 0) {
        return buildGitErrorResult("checkout-failed");
      }
      return null;
    };

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
        const failure = await runGitCheckoutOrFail(`git checkout ${DEV_BRANCH}`, [
          "git",
          "-C",
          gitRoot,
          "checkout",
          DEV_BRANCH,
        ]);
        if (failure) {
          return failure;
        }
      }

      const fetchStep = await runStep(
        step("git fetch", ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"], gitRoot),
      );
      steps.push(fetchStep);
      let preflightBaseSha: string | null = null;
      let candidates: string[] = [];
      if (devTargetRef) {
        let targetSha: string | null = null;
        for (const targetRefCandidate of buildDevTargetRefResolutionCandidates(devTargetRef)) {
          const targetShaStep = await runStep(
            step(
              `git rev-parse ${targetRefCandidate}`,
              ["git", "-C", gitRoot, "rev-parse", targetRefCandidate],
              gitRoot,
            ),
          );
          steps.push(targetShaStep);
          const resolvedTargetSha = targetShaStep.stdoutTail?.trim();
          if (targetShaStep.exitCode === 0 && resolvedTargetSha) {
            targetSha = resolvedTargetSha;
            break;
          }
        }
        if (!targetSha) {
          return {
            status: "error",
            mode: "git",
            root: gitRoot,
            reason: "no-target-sha",
            before: { sha: beforeSha, version: beforeVersion },
            steps,
            durationMs: Date.now() - startedAt,
          };
        }
        preflightBaseSha = targetSha;
        candidates = [targetSha];
      } else {
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

        candidates = (revListStep.stdoutTail ?? "")
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
        preflightBaseSha = upstreamSha;
      }
      if (!preflightBaseSha) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "preflight-base-missing",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const manager = await resolveUpdateBuildManager(
        (argv, options) => runCommand(argv, { timeoutMs: options.timeoutMs, env: options.env }),
        gitRoot,
        timeoutMs,
        defaultCommandEnv,
        "require-preferred",
      );
      if (manager.kind === "missing-required") {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: mapManagerResolutionFailure(manager.reason),
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
      const preflightRoot = await createPreflightRoot();
      const worktreeDir = resolvePreflightWorktreeDir(preflightRoot);
      const worktreeStep = await runStep(
        step(
          "preflight worktree",
          ["git", "-C", gitRoot, "worktree", "add", "--detach", worktreeDir, preflightBaseSha],
          gitRoot,
        ),
      );
      steps.push(worktreeStep);
      if (worktreeStep.exitCode !== 0) {
        await removePathRecursive(preflightRoot);
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
          if (checkoutStep.exitCode !== 0) {
            continue;
          }

          const preflightIgnoreScripts = shouldPreferIgnoreScriptsForWindowsPreflight(
            manager.manager,
          );
          const preflightIgnoreScriptsArgv = managerInstallIgnoreScriptsArgs(manager.manager);
          const depsStepArgv =
            preflightIgnoreScripts && preflightIgnoreScriptsArgv
              ? preflightIgnoreScriptsArgv
              : managerInstallArgs(manager.manager, {
                  compatFallback: manager.fallback && manager.manager === "npm",
                });
          const depsStepName = preflightIgnoreScripts
            ? `preflight deps install (ignore scripts) (${shortSha})`
            : `preflight deps install (${shortSha})`;
          const depsStep = await runStep(
            step(depsStepName, depsStepArgv, worktreeDir, manager.env),
          );
          steps.push(depsStep);
          let finalDepsStep = depsStep;
          if (
            depsStep.exitCode !== 0 &&
            !preflightIgnoreScripts &&
            shouldRetryWindowsInstallIgnoringScripts(manager.manager)
          ) {
            const retryArgv = managerInstallIgnoreScriptsArgs(manager.manager);
            if (retryArgv) {
              const retryStep = await runStep(
                step(
                  `preflight deps install (ignore scripts) (${shortSha})`,
                  retryArgv,
                  worktreeDir,
                  manager.env,
                ),
              );
              steps.push(retryStep);
              finalDepsStep = retryStep;
            }
          }
          if (finalDepsStep.exitCode !== 0) {
            continue;
          }

          const buildStep = await runStep(
            step(
              `preflight build (${shortSha})`,
              managerScriptArgs(manager.manager, "build"),
              worktreeDir,
              resolveWindowsBuildEnv(manager.env),
            ),
          );
          steps.push(buildStep);
          if (buildStep.exitCode !== 0) {
            continue;
          }

          if (shouldRunDevPreflightLint()) {
            const lintStep = await runStep(
              step(
                `preflight lint (${shortSha})`,
                managerScriptArgs(manager.manager, "lint"),
                worktreeDir,
                manager.env,
              ),
            );
            steps.push(lintStep);
            if (lintStep.exitCode !== 0) {
              continue;
            }
          }

          selectedSha = sha;
          break;
        }
      } finally {
        const removeStep = await runStep({
          ...step(
            "preflight cleanup",
            ["git", "-C", gitRoot, "worktree", "remove", "--force", worktreeDir],
            gitRoot,
          ),
          timeoutMs: Math.min(timeoutMs, PREFLIGHT_CLEANUP_TIMEOUT_MS),
        });
        if (
          removeStep.exitCode !== 0 &&
          (await repairPreflightCleanup(worktreeDir, preflightRoot))
        ) {
          removeStep.exitCode = 0;
          const fallbackMessage =
            process.platform === "win32"
              ? "windows fallback cleanup removed preflight tree"
              : "fallback cleanup removed preflight tree";
          removeStep.stderrTail = trimLogTail(
            [removeStep.stderrTail, fallbackMessage].filter(Boolean).join("\n"),
            MAX_LOG_CHARS,
          );
        }
        steps.push(removeStep);
        await runCommand(["git", "-C", gitRoot, "worktree", "prune"], {
          cwd: gitRoot,
          timeoutMs,
        }).catch(() => null);
        await removePathRecursive(preflightRoot);
        await manager.cleanup?.();
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

      if (devTargetRef) {
        const failure = await runGitCheckoutOrFail(`git checkout ${selectedSha}`, [
          "git",
          "-C",
          gitRoot,
          "checkout",
          "--detach",
          selectedSha,
        ]);
        if (failure) {
          return failure;
        }
      } else {
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

      const failure = await runGitCheckoutOrFail(`git checkout ${tag}`, [
        "git",
        "-C",
        gitRoot,
        "checkout",
        "--detach",
        tag,
      ]);
      if (failure) {
        return failure;
      }
    }

    const manager = await resolveUpdateBuildManager(
      (argv, options) => runCommand(argv, { timeoutMs: options.timeoutMs, env: options.env }),
      gitRoot,
      timeoutMs,
      defaultCommandEnv,
      "require-preferred",
    );
    if (manager.kind === "missing-required") {
      return {
        status: "error",
        mode: "git",
        root: gitRoot,
        reason: mapManagerResolutionFailure(manager.reason),
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }
    try {
      const depsStep = await runStep(
        step(
          "deps install",
          managerInstallArgs(manager.manager, {
            compatFallback: manager.fallback && manager.manager === "npm",
          }),
          gitRoot,
          manager.env,
        ),
      );
      steps.push(depsStep);
      let finalDepsStep = depsStep;
      if (depsStep.exitCode !== 0 && shouldRetryWindowsInstallIgnoringScripts(manager.manager)) {
        const retryArgv = managerInstallIgnoreScriptsArgs(manager.manager);
        if (retryArgv) {
          const retryStep = await runStep(
            step("deps install (ignore scripts)", retryArgv, gitRoot, manager.env),
          );
          steps.push(retryStep);
          finalDepsStep = retryStep;
        }
      }
      if (finalDepsStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "deps-install-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const buildStep = await runStep(
        step(
          "build",
          managerScriptArgs(manager.manager, "build"),
          gitRoot,
          resolveWindowsBuildEnv(manager.env),
        ),
      );
      steps.push(buildStep);
      if (buildStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "build-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const uiBuildStep = await runStep(
        step("ui:build", managerScriptArgs(manager.manager, "ui:build"), gitRoot, manager.env),
      );
      steps.push(uiBuildStep);
      if (uiBuildStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "ui-build-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const doctorEntry = path.join(gitRoot, "openclaw.mjs");
      const doctorEntryExists = await fs
        .stat(doctorEntry)
        .then(() => true)
        .catch(() => false);
      if (!doctorEntryExists) {
        steps.push({
          name: "openclaw doctor entry",
          command: `verify ${doctorEntry}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: `missing ${doctorEntry}`,
        });
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "doctor-entry-missing",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      // Use --fix so that doctor auto-strips unknown config keys introduced by
      // schema changes between versions, preventing a startup validation crash.
      const doctorNodePath = await resolveStableNodePath(process.execPath);
      const doctorArgv = [doctorNodePath, doctorEntry, "doctor", "--non-interactive", "--fix"];
      const doctorStep = await runStep(
        step("openclaw doctor", doctorArgv, gitRoot, {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
        }),
      );
      steps.push(doctorStep);
      if (doctorStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          root: gitRoot,
          reason: "doctor-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const uiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
      if (!uiIndexHealth.exists) {
        const repairArgv = managerScriptArgs(manager.manager, "ui:build");
        const started = Date.now();
        const repairResult = await runCommand(repairArgv, {
          cwd: gitRoot,
          timeoutMs,
          env: manager.env,
        });
        const repairStep: UpdateStepResult = {
          name: "ui:build (post-doctor repair)",
          command: repairArgv.join(" "),
          cwd: gitRoot,
          durationMs: Date.now() - started,
          exitCode: repairResult.code,
          stdoutTail: trimLogTail(repairResult.stdout, MAX_LOG_CHARS),
          stderrTail: trimLogTail(repairResult.stderr, MAX_LOG_CHARS),
        };
        steps.push(repairStep);

        if (repairResult.code !== 0) {
          return {
            status: "error",
            mode: "git",
            root: gitRoot,
            reason: "ui-build-failed",
            before: { sha: beforeSha, version: beforeVersion },
            steps,
            durationMs: Date.now() - startedAt,
          };
        }

        const repairedUiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
        if (!repairedUiIndexHealth.exists) {
          const uiIndexPath =
            repairedUiIndexHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
          steps.push({
            name: "ui assets verify",
            command: `verify ${uiIndexPath}`,
            cwd: gitRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: `missing ${uiIndexPath}`,
          });
          return {
            status: "error",
            mode: "git",
            root: gitRoot,
            reason: "ui-assets-missing",
            before: { sha: beforeSha, version: beforeVersion },
            steps,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const failedStep = findBlockingGitFailure(steps);
      const afterShaStep = await runStep(
        step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
      );
      steps.push(afterShaStep);
      const afterVersion = await readPackageVersion(gitRoot);

      return {
        status: failedStep ? "error" : "ok",
        mode: "git",
        root: gitRoot,
        reason: failedStep ? normalizeFallbackFailureReason(failedStep.name) : undefined,
        before: { sha: beforeSha, version: beforeVersion },
        after: {
          sha: afterShaStep.stdoutTail?.trim() ?? null,
          version: afterVersion,
        },
        steps,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await manager.cleanup?.();
    }
  }

  if (!pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      reason: "not-openclaw-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  const globalManager = await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs);
  if (globalManager) {
    const installTarget = await resolveGlobalInstallTarget({
      manager: globalManager,
      runCommand,
      timeoutMs,
      pkgRoot,
    });
    const packageName = (await readPackageName(pkgRoot)) ?? DEFAULT_PACKAGE_NAME;
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
    const channel = opts.channel ?? DEFAULT_PACKAGE_CHANNEL;
    const tag = normalizeTag(opts.tag ?? channelToNpmTag(channel));
    const globalInstallEnv = await createGlobalInstallEnv();
    const spec = resolveGlobalInstallSpec({
      packageName,
      tag,
      env: globalInstallEnv,
    });
    const packageUpdate = await runGlobalPackageUpdateSteps({
      installTarget,
      installSpec: spec,
      packageName,
      packageRoot: pkgRoot,
      runCommand,
      timeoutMs,
      ...(globalInstallEnv === undefined ? {} : { env: globalInstallEnv }),
      installCwd: pkgRoot,
      runStep: (stepParams) =>
        runStep({
          runCommand,
          ...stepParams,
          cwd: stepParams.cwd ?? pkgRoot,
          progress,
          stepIndex: 0,
          totalSteps: 1,
        }),
      postVerifyStep: async (verifiedPackageRoot) => {
        const doctorEntry = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
        if (!doctorEntry) {
          return null;
        }
        const doctorNodePath = await resolveStableNodePath(process.execPath);
        return await runStep({
          runCommand,
          name: "openclaw doctor",
          argv: [doctorNodePath, doctorEntry, "doctor", "--non-interactive", "--fix"],
          cwd: verifiedPackageRoot,
          timeoutMs,
          env: {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
          },
          progress,
          stepIndex: 0,
          totalSteps: 1,
        });
      },
    });
    return {
      status: packageUpdate.failedStep ? "error" : "ok",
      mode: globalManager,
      root: packageUpdate.verifiedPackageRoot ?? pkgRoot,
      reason: packageUpdate.failedStep
        ? normalizeFallbackFailureReason(packageUpdate.failedStep.name)
        : undefined,
      before: { version: beforeVersion },
      after: { version: packageUpdate.afterVersion },
      steps: packageUpdate.steps,
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
