import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { trimLogTail } from "./restart-sentinel.js";
import { DEV_BRANCH } from "./update-channels.js";
import {
  managerInstallArgs,
  managerInstallIgnoreScriptsArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { MAX_LOG_CHARS, runStep } from "./update-runner-command.js";
import {
  mapManagerResolutionFailure,
  resolveBuildEnv,
  resolveDevPreflightLintEnv,
  resolveInstallEnv,
  resolveRetryInstallArgs,
  shouldPreferIgnoreScriptsForWindowsPreflight,
  shouldRetryWindowsInstallIgnoringScripts,
  shouldRunDevPreflightLint,
} from "./update-runner-git-commands.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateStepResult,
} from "./update-runner-types.js";

const PREFLIGHT_MAX_COMMITS = 10;
const PREFLIGHT_TEMP_PREFIX =
  process.platform === "win32" ? "ocu-pf-" : "openclaw-update-preflight-";
const PREFLIGHT_WORKTREE_DIRNAME = process.platform === "win32" ? "wt" : "worktree";
const PREFLIGHT_CLEANUP_TIMEOUT_MS = 60_000;
const WINDOWS_PREFLIGHT_BASE_DIR = "ocu";

type StepFactory = (
  name: string,
  argv: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => RunStepOptions;

type GitDevPreflightResult =
  | {
      status: "ok";
      selectedSha: string;
      selectedDevUpstream: string | null;
      localDevBranchExists: boolean | null;
    }
  | { status: "error" | "skipped"; reason: NonNullable<UpdateRunResult["reason"]> };

function normalizeDevTargetRef(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function looksLikeFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value.trim());
}

function resolveTagFetchRef(candidate: string): string | null {
  const ref = candidate.endsWith("^{}") ? candidate.slice(0, -"^{}".length) : candidate;
  return ref.startsWith("refs/tags/") ? ref : null;
}

function buildDevTargetRefResolutionCandidates(devTargetRef: string): string[] {
  const trimmed = devTargetRef.trim();
  const candidates: string[] = [];
  const addCandidate = (candidate?: string | null) => {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };
  if (looksLikeFullCommitSha(trimmed) || trimmed.startsWith("refs/remotes/")) {
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
  // Plain branch names resolve from the freshly fetched remote ref.
  addCandidate(`refs/remotes/origin/${trimmed}`);
  addCandidate(`refs/tags/${trimmed}^{}`);
  addCandidate(`refs/tags/${trimmed}`);
  return candidates;
}

function resolvePreflightWorktreeDir(preflightRoot: string) {
  return path.join(preflightRoot, PREFLIGHT_WORKTREE_DIRNAME);
}

async function createPreflightRoot() {
  if (process.platform === "win32" && path.sep === "\\") {
    const baseDir = path.win32.join(process.env.SystemDrive ?? "C:", WINDOWS_PREFLIGHT_BASE_DIR);
    await fs.mkdir(baseDir, { recursive: true });
    return fs.mkdtemp(path.win32.join(baseDir, PREFLIGHT_TEMP_PREFIX));
  }
  return fs.mkdtemp(path.join(os.tmpdir(), PREFLIGHT_TEMP_PREFIX));
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

async function resolveExplicitTarget(params: {
  devTargetRef: string;
  gitRoot: string;
  steps: UpdateStepResult[];
  step: StepFactory;
}): Promise<string | null> {
  for (const candidate of buildDevTargetRefResolutionCandidates(params.devTargetRef)) {
    const tagFetchRef = resolveTagFetchRef(candidate);
    if (tagFetchRef) {
      const remoteStep = await runStep(
        params.step("git remote", ["git", "-C", params.gitRoot, "remote"], params.gitRoot),
      );
      params.steps.push(remoteStep);
      const remotes = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n"));
      let fetchedTag = false;
      for (const remote of remotes) {
        const fetchStep = await runStep(
          params.step(
            `git fetch ${remote} ${tagFetchRef}`,
            ["git", "-C", params.gitRoot, "fetch", remote, `+${tagFetchRef}:${tagFetchRef}`],
            params.gitRoot,
          ),
        );
        params.steps.push(fetchStep);
        if (fetchStep.exitCode === 0) {
          fetchedTag = true;
          break;
        }
      }
      if (remotes.length > 0 && !fetchedTag) {
        continue;
      }
    }
    const shaStep = await runStep(
      params.step(
        `git rev-parse ${candidate}`,
        ["git", "-C", params.gitRoot, "rev-parse", candidate],
        params.gitRoot,
      ),
    );
    params.steps.push(shaStep);
    const sha = shaStep.stdoutTail?.trim();
    if (shaStep.exitCode === 0 && sha) {
      return sha;
    }
  }
  return null;
}

async function resolveUpstreamCandidates(params: {
  gitRoot: string;
  needsCheckoutMain: boolean;
  steps: UpdateStepResult[];
  step: StepFactory;
}): Promise<
  | {
      status: "ok";
      sha: string;
      candidates: string[];
      selectedDevUpstream: string | null;
      localDevBranchExists: boolean | null;
    }
  | { status: "error" | "skipped"; reason: NonNullable<UpdateRunResult["reason"]> }
> {
  let localDevBranchExists: boolean | null = null;
  let remoteBranchRefs: string[] = [];
  if (params.needsCheckoutMain) {
    const localMainStep = await runStep(
      params.step(
        `git show-ref ${DEV_BRANCH}`,
        ["git", "-C", params.gitRoot, "show-ref", "--verify", `refs/heads/${DEV_BRANCH}`],
        params.gitRoot,
      ),
    );
    params.steps.push(localMainStep);
    localDevBranchExists = localMainStep.exitCode === 0;
  }
  if (params.needsCheckoutMain && localDevBranchExists === false) {
    const remoteStep = await runStep(
      params.step("git remote", ["git", "-C", params.gitRoot, "remote"], params.gitRoot),
    );
    params.steps.push(remoteStep);
    if (remoteStep.exitCode === 0) {
      remoteBranchRefs = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n")).map(
        (remote) => `refs/remotes/${remote}/${DEV_BRANCH}`,
      );
    }
  }
  const upstreamRefs = params.needsCheckoutMain
    ? [`${DEV_BRANCH}@{upstream}`, ...remoteBranchRefs]
    : ["@{upstream}"];
  let upstreamSha: string | null = null;
  let selectedDevUpstream: string | null = null;
  let sawResolvableUpstreamRef = false;
  for (const upstreamRef of upstreamRefs) {
    if (upstreamRef.endsWith("@{upstream}")) {
      const upstreamStep = await runStep(
        params.step(
          "upstream check",
          [
            "git",
            "-C",
            params.gitRoot,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            upstreamRef,
          ],
          params.gitRoot,
        ),
      );
      params.steps.push(upstreamStep);
      if (upstreamStep.exitCode !== 0) {
        continue;
      }
      sawResolvableUpstreamRef = true;
    }
    const shaStep = await runStep(
      params.step(
        `git rev-parse ${upstreamRef}`,
        ["git", "-C", params.gitRoot, "rev-parse", upstreamRef],
        params.gitRoot,
      ),
    );
    params.steps.push(shaStep);
    const sha = shaStep.stdoutTail?.trim();
    if (shaStep.exitCode === 0 && sha) {
      upstreamSha = sha;
      selectedDevUpstream = /^refs\/remotes\/(.+)$/u.exec(upstreamRef)?.[1] ?? null;
      break;
    }
    if (shaStep.exitCode === 0) {
      sawResolvableUpstreamRef = true;
    }
  }
  if (!upstreamSha) {
    return sawResolvableUpstreamRef
      ? { status: "error", reason: "no-upstream-sha" }
      : { status: "skipped", reason: "no-upstream" };
  }
  const revListStep = await runStep(
    params.step(
      "git rev-list",
      [
        "git",
        "-C",
        params.gitRoot,
        "rev-list",
        `--max-count=${PREFLIGHT_MAX_COMMITS}`,
        upstreamSha,
      ],
      params.gitRoot,
    ),
  );
  params.steps.push(revListStep);
  if (revListStep.exitCode !== 0) {
    return { status: "error", reason: "preflight-revlist-failed" };
  }
  const candidates = normalizeStringEntries((revListStep.stdoutTail ?? "").split("\n"));
  if (candidates.length === 0) {
    return { status: "error", reason: "preflight-no-candidates" };
  }
  return {
    status: "ok",
    sha: upstreamSha,
    candidates,
    selectedDevUpstream,
    localDevBranchExists,
  };
}

async function testPreflightCandidates(params: {
  gitRoot: string;
  worktreeDir: string;
  candidates: string[];
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
}): Promise<{
  selectedSha: string | null;
  managerReason: string | null;
  sawOtherFailure: boolean;
}> {
  let selectedSha: string | null = null;
  let managerReason: string | null = null;
  let sawOtherFailure = false;
  for (const sha of params.candidates) {
    const shortSha = sha.slice(0, 8);
    const checkoutStep = await runStep(
      params.step(
        `preflight checkout (${shortSha})`,
        ["git", "-C", params.worktreeDir, "checkout", "--detach", sha],
        params.worktreeDir,
      ),
    );
    params.steps.push(checkoutStep);
    if (checkoutStep.exitCode !== 0) {
      sawOtherFailure = true;
      continue;
    }
    const manager = await resolveUpdateBuildManager(
      (argv, options) =>
        params.runCommand(argv, { timeoutMs: options.timeoutMs, env: options.env }),
      params.worktreeDir,
      params.timeoutMs,
      params.defaultCommandEnv,
      "require-preferred",
    );
    if (manager.kind === "missing-required") {
      managerReason = mapManagerResolutionFailure(manager.reason);
      params.steps.push({
        name: `preflight package manager (${shortSha})`,
        command: `resolve ${manager.preferred} package manager`,
        cwd: params.worktreeDir,
        durationMs: 0,
        exitCode: 1,
        stderrTail: managerReason,
      });
      continue;
    }
    try {
      const preferIgnoreScripts = shouldPreferIgnoreScriptsForWindowsPreflight(manager.manager);
      const ignoreScriptsArgv = managerInstallIgnoreScriptsArgs(manager.manager);
      const installArgv =
        preferIgnoreScripts && ignoreScriptsArgv
          ? ignoreScriptsArgv
          : managerInstallArgs(manager.manager, {
              compatFallback: manager.fallback && manager.manager === "npm",
            });
      const installName = preferIgnoreScripts
        ? `preflight deps install (ignore scripts) (${shortSha})`
        : `preflight deps install (${shortSha})`;
      const installEnv = resolveInstallEnv(manager.manager, manager.env);
      let installStep = await runStep(
        params.step(installName, installArgv, params.worktreeDir, installEnv),
      );
      params.steps.push(installStep);
      if (
        installStep.exitCode !== 0 &&
        !preferIgnoreScripts &&
        shouldRetryWindowsInstallIgnoringScripts(manager.manager)
      ) {
        const retryArgv = resolveRetryInstallArgs(manager.manager);
        if (retryArgv) {
          installStep = await runStep(
            params.step(
              `preflight deps install (ignore scripts) (${shortSha})`,
              retryArgv,
              params.worktreeDir,
              installEnv,
            ),
          );
          params.steps.push(installStep);
        }
      }
      if (installStep.exitCode !== 0) {
        sawOtherFailure = true;
        continue;
      }
      const buildStep = await runStep(
        params.step(
          `preflight build (${shortSha})`,
          managerScriptArgs(manager.manager, "build"),
          params.worktreeDir,
          resolveBuildEnv(manager.env),
        ),
      );
      params.steps.push(buildStep);
      if (buildStep.exitCode !== 0) {
        sawOtherFailure = true;
        continue;
      }
      if (shouldRunDevPreflightLint()) {
        const lintStep = await runStep(
          params.step(
            `preflight lint (${shortSha})`,
            managerScriptArgs(manager.manager, "lint"),
            params.worktreeDir,
            resolveDevPreflightLintEnv(manager.env),
          ),
        );
        params.steps.push(lintStep);
        if (lintStep.exitCode !== 0) {
          sawOtherFailure = true;
          continue;
        }
      }
      selectedSha = sha;
      break;
    } finally {
      await manager.cleanup?.();
    }
  }
  return { selectedSha, managerReason, sawOtherFailure };
}

export async function runGitDevPreflight(params: {
  gitRoot: string;
  devTargetRef?: string;
  needsCheckoutMain: boolean;
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
}): Promise<GitDevPreflightResult> {
  const devTargetRef = normalizeDevTargetRef(params.devTargetRef);
  let preflightBaseSha: string;
  let candidates: string[];
  let selectedDevUpstream: string | null = null;
  let localDevBranchExists: boolean | null = null;
  if (devTargetRef) {
    const targetSha = await resolveExplicitTarget({ ...params, devTargetRef });
    if (!targetSha) {
      return { status: "error", reason: "no-target-sha" };
    }
    preflightBaseSha = targetSha;
    candidates = [targetSha];
  } else {
    const upstream = await resolveUpstreamCandidates(params);
    if (upstream.status !== "ok") {
      return upstream;
    }
    preflightBaseSha = upstream.sha;
    candidates = upstream.candidates;
    selectedDevUpstream = upstream.selectedDevUpstream;
    localDevBranchExists = upstream.localDevBranchExists;
  }

  const preflightRoot = await createPreflightRoot();
  const worktreeDir = resolvePreflightWorktreeDir(preflightRoot);
  const worktreeStep = await runStep(
    params.step(
      "preflight worktree",
      ["git", "-C", params.gitRoot, "worktree", "add", "--detach", worktreeDir, preflightBaseSha],
      params.gitRoot,
    ),
  );
  params.steps.push(worktreeStep);
  if (worktreeStep.exitCode !== 0) {
    await removePathRecursive(preflightRoot);
    return { status: "error", reason: "preflight-worktree-failed" };
  }

  let tested: Awaited<ReturnType<typeof testPreflightCandidates>>;
  try {
    tested = await testPreflightCandidates({ ...params, worktreeDir, candidates });
  } finally {
    const removeStep = await runStep({
      ...params.step(
        "preflight cleanup",
        ["git", "-C", params.gitRoot, "worktree", "remove", "--force", worktreeDir],
        params.gitRoot,
      ),
      timeoutMs: Math.min(params.timeoutMs, PREFLIGHT_CLEANUP_TIMEOUT_MS),
    });
    if (removeStep.exitCode !== 0 && (await repairPreflightCleanup(worktreeDir, preflightRoot))) {
      removeStep.exitCode = 0;
      const message =
        process.platform === "win32"
          ? "windows fallback cleanup removed preflight tree"
          : "fallback cleanup removed preflight tree";
      removeStep.stderrTail = trimLogTail(
        [removeStep.stderrTail, message].filter(Boolean).join("\n"),
        MAX_LOG_CHARS,
      );
    }
    params.steps.push(removeStep);
    await params
      .runCommand(["git", "-C", params.gitRoot, "worktree", "prune"], {
        cwd: params.gitRoot,
        timeoutMs: params.timeoutMs,
      })
      .catch(() => null);
    await removePathRecursive(preflightRoot);
  }
  if (!tested.selectedSha) {
    return {
      status: "error",
      reason:
        tested.managerReason && !tested.sawOtherFailure
          ? tested.managerReason
          : "preflight-no-good-commit",
    };
  }
  return {
    status: "ok",
    selectedSha: tested.selectedSha,
    selectedDevUpstream,
    localDevBranchExists,
  };
}
