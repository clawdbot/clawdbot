import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { hasErrnoCode } from "./errno.js";
import { trimLogTail } from "./restart-sentinel.js";
import { DEV_BRANCH, resolveDevUpstreamRefs } from "./update-channels.js";
import { resolveDevUpdateTargetRevision, type DevUpdateTarget } from "./update-dev-target.js";
import {
  managerInstallArgs,
  managerInstallIgnoreScriptsArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { MAX_LOG_CHARS, runStep } from "./update-runner-command.js";
import {
  resolveBuildEnv,
  resolveDevPreflightLintEnv,
  resolveInstallEnv,
  shouldInstallWithoutScriptsOnWindows,
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
  process.platform === "win32" ? "ocu-pf-" : ".openclaw-update-preflight-";
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

async function createPreflightRoot(gitRoot: string) {
  // On POSIX, ignored artifact storage keeps interrupted worktrees out of Git status.
  // Honor existing redirects like build-all-cache; only the mkdtemp child is private.
  const baseDir =
    process.platform === "win32" && path.sep === "\\"
      ? path.win32.join(process.env.SystemDrive ?? "C:", WINDOWS_PREFLIGHT_BASE_DIR)
      : path.join(await fs.realpath(gitRoot), ".artifacts");
  await fs.mkdir(baseDir, { recursive: true });
  return fs.mkdtemp(path.join(baseDir, PREFLIGHT_TEMP_PREFIX));
}

async function removePathRecursive(target: string) {
  await fs
    .rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    .catch(() => {});
}

async function resetPreflightCandidateWorktree(
  worktreeDir: string,
  shortSha: string,
  step: StepFactory,
) {
  const resetStep = await runStep(
    step(
      `preflight reset (${shortSha})`,
      ["git", "-C", worktreeDir, "reset", "--hard"],
      worktreeDir,
    ),
  );
  if (resetStep.exitCode !== 0) {
    return false;
  }
  const cleanStep = await runStep(
    step(`preflight clean (${shortSha})`, ["git", "-C", worktreeDir, "clean", "-fdx"], worktreeDir),
  );
  return cleanStep.exitCode === 0;
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
      if (remoteStep.exitCode !== 0) {
        return null;
      }
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
    localDevBranchExists = localMainStep.exitCode === 0;
  }
  if (params.needsCheckoutMain && localDevBranchExists === false) {
    const remoteStep = await runStep(
      params.step("git remote", ["git", "-C", params.gitRoot, "remote"], params.gitRoot),
    );
    if (remoteStep.exitCode !== 0) {
      return { status: "error", reason: "preflight-remote-failed" };
    }
    remoteBranchRefs = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n")).map(
      (remote) => `refs/remotes/${remote}/${DEV_BRANCH}`,
    );
  }
  const upstreamRefs = resolveDevUpstreamRefs(params.needsCheckoutMain, remoteBranchRefs);
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

type PreflightCandidateResult =
  | { status: "ok"; selectedSha: string }
  | { status: "manager-unavailable"; reason: string }
  | { status: "failed" | "insufficient-space" };

function classifyPreflightFailure(step: UpdateStepResult): "failed" | "insufficient-space" {
  // pnpm reports filesystem errors on stdout by default. Require the storage
  // diagnostic: ENOSPC also covers inotify limits.
  const output = stripAnsi(`${step.stdoutTail ?? ""}\n${step.stderrTail ?? ""}`);
  const nodeNoSpace =
    /^\s*(?:\[(?:ERR_PNPM_)?ENOSPC\][^\r\n]*|(?:Error:\s*)?)ENOSPC: no space left on device(?:,|$)/m.test(
      output,
    );
  // Git uses strerror without an errno token; require a complete operation diagnostic.
  const gitNoSpace =
    /^(?:fatal|error): (?:cannot|could not|unable to) [^\r\n]+: No space left on device$/m.test(
      output,
    );
  return nodeNoSpace || gitNoSpace ? "insufficient-space" : "failed";
}

async function testPreflightCandidate(params: {
  gitRoot: string;
  worktreeDir: string;
  sha: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
}): Promise<PreflightCandidateResult> {
  const shortSha = params.sha.slice(0, 8);
  if (!(await resetPreflightCandidateWorktree(params.worktreeDir, shortSha, params.step))) {
    return { status: "failed" };
  }
  const runCandidateCheck = async (name: string, argv: string[], env?: NodeJS.ProcessEnv) => {
    const check = params.step(`preflight ${name} (${shortSha})`, argv, params.worktreeDir, env);
    const result = await runStep(check);
    return result.exitCode === 0 ? null : result;
  };
  const checkout = await runCandidateCheck("checkout", [
    "git",
    "-C",
    params.worktreeDir,
    "checkout",
    "--detach",
    params.sha,
  ]);
  if (checkout) {
    return { status: classifyPreflightFailure(checkout) };
  }
  const manager = await resolveUpdateBuildManager(
    params.runCommand,
    params.worktreeDir,
    params.timeoutMs,
    params.defaultCommandEnv,
    "require-preferred",
  );
  if (manager.kind === "missing-required") {
    params.steps.push({
      name: `preflight package manager (${shortSha})`,
      command: `resolve ${manager.preferred} package manager`,
      cwd: params.worktreeDir,
      durationMs: 0,
      exitCode: 1,
      stderrTail: manager.reason,
    });
    return { status: "manager-unavailable", reason: manager.reason };
  }
  try {
    const preferIgnoreScripts = shouldInstallWithoutScriptsOnWindows(manager.manager);
    const ignoreScriptsArgv = managerInstallIgnoreScriptsArgs(manager.manager);
    const installArgv =
      preferIgnoreScripts && ignoreScriptsArgv
        ? ignoreScriptsArgv
        : managerInstallArgs(manager.manager, {
            compatFallback: manager.fallback && manager.manager === "npm",
          });
    const installName = preferIgnoreScripts ? "deps install (ignore scripts)" : "deps install";
    const installEnv = await resolveInstallEnv(
      manager.manager,
      manager.env ?? params.defaultCommandEnv,
      params.worktreeDir,
      params.runCommand,
      params.timeoutMs,
    );
    const buildArgs = managerScriptArgs(manager.manager, "build");
    const buildEnv = resolveBuildEnv(
      manager.env ?? params.defaultCommandEnv,
      path.join(params.gitRoot, ".artifacts", "build-all-cache"),
    );
    const configArgs = managerScriptArgs(manager.manager, "openclaw", [
      "config",
      "validate",
      "--json",
    ]);
    const lintArgs = managerScriptArgs(manager.manager, "lint");
    const failure =
      (await runCandidateCheck(installName, installArgv, installEnv)) ??
      (await runCandidateCheck("build", buildArgs, buildEnv)) ??
      (await runCandidateCheck("config validate", configArgs, manager.env)) ??
      (shouldRunDevPreflightLint()
        ? await runCandidateCheck("lint", lintArgs, resolveDevPreflightLintEnv(manager.env))
        : null);
    return failure
      ? { status: classifyPreflightFailure(failure) }
      : { status: "ok", selectedSha: params.sha };
  } finally {
    await manager.cleanup?.();
  }
}

export async function runGitDevPreflight(params: {
  gitRoot: string;
  devTarget?: DevUpdateTarget;
  needsCheckoutMain: boolean;
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
}): Promise<GitDevPreflightResult> {
  const devTargetRef = params.devTarget
    ? normalizeDevTargetRef(resolveDevUpdateTargetRevision(params.devTarget))
    : null;
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
    if (params.devTarget?.mode === "tracked") {
      const ancestryStep = await runStep(
        params.step(
          "tracked target ancestry",
          [
            "git",
            "-C",
            params.gitRoot,
            "merge-base",
            "--is-ancestor",
            targetSha,
            `${params.devTarget.upstreamRef}^{commit}`,
          ],
          params.gitRoot,
        ),
      );
      if (ancestryStep.exitCode !== 0) {
        return { status: "error", reason: "tracked-upstream-invalid" };
      }
    }
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

  let preflightRoot: string;
  try {
    preflightRoot = await createPreflightRoot(params.gitRoot);
  } catch (error) {
    return {
      status: "error",
      reason: hasErrnoCode(error, "ENOSPC")
        ? "preflight-insufficient-space"
        : "preflight-worktree-failed",
    };
  }
  const worktreeDir = resolvePreflightWorktreeDir(preflightRoot);
  const worktreeStep = await runStep(
    params.step(
      "preflight worktree",
      ["git", "-C", params.gitRoot, "worktree", "add", "--detach", worktreeDir, preflightBaseSha],
      params.gitRoot,
    ),
  );
  if (worktreeStep.exitCode !== 0) {
    await removePathRecursive(preflightRoot);
    return {
      status: "error",
      reason:
        classifyPreflightFailure(worktreeStep) === "insufficient-space"
          ? "preflight-insufficient-space"
          : "preflight-worktree-failed",
    };
  }

  let tested: PreflightCandidateResult | undefined;
  let cleanupFailed: boolean;
  try {
    for (const sha of candidates) {
      const candidate = await testPreflightCandidate({ ...params, worktreeDir, sha });
      if (candidate.status === "ok" || candidate.status === "insufficient-space") {
        tested = candidate;
        break;
      }
      // A missing manager must not hide another candidate's checkout/build failure.
      if (tested?.status !== "failed") {
        tested = candidate;
      }
    }
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
    cleanupFailed = removeStep.exitCode !== 0;
    await params
      .runCommand(["git", "-C", params.gitRoot, "worktree", "prune"], {
        cwd: params.gitRoot,
        timeoutMs: params.timeoutMs,
      })
      .catch(() => null);
    await removePathRecursive(preflightRoot);
  }
  if (tested?.status !== "ok") {
    return {
      status: "error",
      reason:
        tested?.status === "insufficient-space"
          ? "preflight-insufficient-space"
          : tested?.status === "manager-unavailable"
            ? tested.reason
            : "preflight-no-good-commit",
    };
  }
  if (cleanupFailed) {
    return { status: "error", reason: "preflight-cleanup-failed" };
  }
  return {
    status: "ok",
    selectedSha: tested.selectedSha,
    selectedDevUpstream,
    localDevBranchExists,
  };
}
