import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
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
  gitCleanCheckArgs,
  prepareCandidateCommandEnv,
  resolveBuildEnv,
  resolveDevPreflightLintEnv,
  shouldInstallWithoutScriptsOnWindows,
  shouldRunDevPreflightLint,
} from "./update-runner-git-commands.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateRunnerOptions,
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

type GitCandidatePreflightResult =
  | {
      status: "ok";
      candidateSha: string;
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
    let resolvedUpstreamRef = upstreamRef;
    if (upstreamRef.endsWith("@{upstream}")) {
      const upstreamStep = await runStep(
        params.step(
          "upstream check",
          ["git", "-C", params.gitRoot, "rev-parse", "--symbolic-full-name", upstreamRef],
          params.gitRoot,
        ),
      );
      if (upstreamStep.exitCode !== 0) {
        continue;
      }
      sawResolvableUpstreamRef = true;
      resolvedUpstreamRef = upstreamStep.stdoutTail?.trim() ?? upstreamRef;
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
      selectedDevUpstream = /^refs\/remotes\/(.+)$/u.exec(resolvedUpstreamRef)?.[1] ?? null;
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
  | { status: "ok"; candidateSha: string }
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
  preflightRoot: string;
  sha: string;
  rebaseFrom?: string;
  runLint: boolean;
  beforeCandidate?: (revision: string) => Promise<void>;
  validateCandidate?: (root: string) => Promise<void>;
  prepareGitExposure?: UpdateRunnerOptions["prepareGitExposure"];
  prepareCandidate?: (root: string, cleanupRoot: string) => Promise<void>;
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
  if (params.rebaseFrom) {
    const source = await runCandidateCheck("local checkout", [
      "git",
      "-C",
      params.worktreeDir,
      "checkout",
      "--detach",
      params.rebaseFrom,
    ]);
    const rebase =
      source ??
      (await runCandidateCheck("rebase", ["git", "-C", params.worktreeDir, "rebase", params.sha]));
    if (rebase) {
      await runCandidateCheck("rebase --abort", [
        "git",
        "-C",
        params.worktreeDir,
        "rebase",
        "--abort",
      ]);
      return { status: classifyPreflightFailure(rebase) };
    }
  }
  const candidateHead = await params.runCommand(
    ["git", "-C", params.worktreeDir, "rev-parse", "HEAD"],
    {
      cwd: params.worktreeDir,
      timeoutMs: params.timeoutMs,
    },
  );
  if (candidateHead.code !== 0 || !candidateHead.stdout.trim()) {
    return { status: "failed" };
  }
  const candidateSha = candidateHead.stdout.trim();
  // A local rebase can change package metadata from the fetched base revision.
  await params.beforeCandidate?.(candidateSha);
  const manager = await resolveUpdateBuildManager(
    params.runCommand,
    params.worktreeDir,
    params.timeoutMs,
    params.defaultCommandEnv,
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
    const installArgv = preferIgnoreScripts
      ? managerInstallIgnoreScriptsArgs(manager.manager)
      : managerInstallArgs(manager.manager, {
          compatFallback: manager.fallback && manager.manager === "npm",
        });
    const installName = preferIgnoreScripts ? "deps install (ignore scripts)" : "deps install";
    const candidateCommand = await prepareCandidateCommandEnv(
      manager.manager,
      manager.env ?? params.defaultCommandEnv,
      params.worktreeDir,
      params.runCommand,
      params.timeoutMs,
    );
    const buildArgs = managerScriptArgs(manager.manager, "build");
    const buildEnv = resolveBuildEnv(
      candidateCommand.env,
      path.join(params.gitRoot, ".artifacts", "build-all-cache"),
    );
    const configArgs = managerScriptArgs(manager.manager, "openclaw", [
      "config",
      "validate",
      "--json",
    ]);
    const lintArgs = managerScriptArgs(manager.manager, "lint");
    let failure =
      (await runCandidateCheck(installName, installArgv, candidateCommand.env)) ??
      (await runCandidateCheck("build", buildArgs, buildEnv));
    if (
      !failure &&
      (await resolveControlUiAssetHealth({ root: params.worktreeDir })).kind !== "ready"
    ) {
      failure = await runCandidateCheck(
        "ui:build",
        managerScriptArgs(manager.manager, "ui:build"),
        candidateCommand.env,
      );
    }
    if (
      !failure &&
      (await resolveControlUiAssetHealth({ root: params.worktreeDir })).kind !== "ready"
    ) {
      params.steps.push({
        name: `preflight ui assets verify (${shortSha})`,
        command: "verify startup assets",
        cwd: params.worktreeDir,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "Candidate Control UI startup assets are missing or incomplete",
      });
      return { status: "failed" };
    }
    if (!failure) {
      failure =
        (params.validateCandidate
          ? null
          : await runCandidateCheck("config validate", configArgs, candidateCommand.env)) ??
        (params.runLint
          ? await runCandidateCheck(
              "lint",
              lintArgs,
              resolveDevPreflightLintEnv(candidateCommand.env),
            )
          : null);
    }
    if (failure) {
      return { status: classifyPreflightFailure(failure) };
    }
    // Global source exposure can run package lifecycle scripts. Validate and retain
    // the resulting candidate only after that preparation finishes.
    await params.prepareGitExposure?.(params.worktreeDir, candidateSha, candidateCommand.env);
    await candidateCommand.restoreWorkspace?.();
    await params.validateCandidate?.(params.worktreeDir);
    // Activation checks out candidateSha and promotes only generated runtime paths.
    // Check after repair so validated source edits cannot disappear at activation.
    const cleanCheck = await runCandidateCheck(
      "candidate clean check",
      gitCleanCheckArgs(params.worktreeDir),
    );
    const status = params.steps.at(-1);
    if (cleanCheck || status?.stdoutTail?.trim()) {
      if (status) {
        status.exitCode = 1;
      }
      return { status: "failed" };
    }
    const sourceCheck = await runCandidateCheck("candidate source check", [
      "git",
      "-C",
      params.worktreeDir,
      "diff",
      "--quiet",
      candidateSha,
      "--",
    ]);
    if (sourceCheck) {
      sourceCheck.stderrTail =
        "Candidate source differs from the selected commit. Repair the source revision before retrying the update.";
      return { status: "failed" };
    }
    await params.prepareCandidate?.(params.worktreeDir, params.preflightRoot);
    return { status: "ok", candidateSha };
  } finally {
    await manager.cleanup?.();
  }
}

export async function runGitCandidatePreflight(params: {
  gitRoot: string;
  devTarget?: DevUpdateTarget;
  targetRevision?: string;
  beforeSha?: string | null;
  validateCandidate?: (root: string) => Promise<void>;
  prepareGitExposure?: UpdateRunnerOptions["prepareGitExposure"];
  prepareCandidate?: (root: string, cleanupRoot: string) => Promise<void>;
  needsCheckoutMain: boolean;
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
  beforeCandidate?: (revision: string) => Promise<void>;
}): Promise<GitCandidatePreflightResult> {
  const devTargetRef = params.devTarget
    ? normalizeDevTargetRef(resolveDevUpdateTargetRevision(params.devTarget))
    : null;
  let preflightBaseSha: string;
  let candidates: string[];
  let selectedDevUpstream: string | null = null;
  let localDevBranchExists: boolean | null = null;
  if (params.targetRevision) {
    const result = await params.runCommand(
      ["git", "-C", params.gitRoot, "rev-parse", `${params.targetRevision}^{commit}`],
      {
        cwd: params.gitRoot,
        timeoutMs: params.timeoutMs,
      },
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return { status: "error", reason: "no-target-sha" };
    }
    preflightBaseSha = result.stdout.trim();
    candidates = [preflightBaseSha];
  } else if (devTargetRef) {
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

  // A resolved no-op must not enter validation, stop the service, or rewrite its runtime.
  if (!params.prepareGitExposure && preflightBaseSha === params.beforeSha) {
    return { status: "skipped", reason: "already-current" };
  }
  const rebaseFrom =
    !params.targetRevision && !params.devTarget && localDevBranchExists !== false
      ? params.needsCheckoutMain
        ? DEV_BRANCH
        : (params.beforeSha ?? undefined)
      : undefined;

  // Worktree checkout can execute filters, and subsequent checks run target code.
  // Admit its metadata before either operation, then admit each distinct fallback.
  await params.beforeCandidate?.(preflightBaseSha);
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
  let tested: PreflightCandidateResult | undefined;
  let cleanupFailed: boolean;
  try {
    const worktreeStep = await runStep(
      params.step(
        "preflight worktree",
        ["git", "-C", params.gitRoot, "worktree", "add", "--detach", worktreeDir, preflightBaseSha],
        params.gitRoot,
      ),
    );
    if (worktreeStep.exitCode !== 0) {
      return {
        status: "error",
        reason:
          classifyPreflightFailure(worktreeStep) === "insufficient-space"
            ? "preflight-insufficient-space"
            : "preflight-worktree-failed",
      };
    }
    for (const sha of candidates) {
      if (!params.prepareGitExposure && sha === params.beforeSha) {
        return { status: "skipped", reason: "already-current" };
      }
      if (sha !== preflightBaseSha) {
        await params.beforeCandidate?.(sha);
      }
      const candidate = await testPreflightCandidate({
        ...params,
        worktreeDir,
        preflightRoot,
        sha,
        rebaseFrom,
        runLint: !params.targetRevision && shouldRunDevPreflightLint(),
      });
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
    // Cancellation ends candidate work, not cleanup of the worktree and its Git metadata.
    // Keep cleanup commands in the owned process tree with their existing bounded budget.
    const cleanupSignal = new AbortController().signal;
    const cleanupTimeoutMs = Math.min(params.timeoutMs, PREFLIGHT_CLEANUP_TIMEOUT_MS);
    const runCleanupCommand: CommandRunner = (argv, options) =>
      params.runCommand(argv, { ...options, signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
    // Interrupted creation can retain Git's initialization lock. This exact temporary
    // worktree is owned here, so force twice instead of leaving a stale registration.
    const removeStep = await runStep({
      ...params.step(
        "preflight cleanup",
        ["git", "-C", params.gitRoot, "worktree", "remove", "--force", "--force", worktreeDir],
        params.gitRoot,
      ),
      runCommand: runCleanupCommand,
      timeoutMs: cleanupTimeoutMs,
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
    await runCleanupCommand(["git", "-C", params.gitRoot, "worktree", "prune"], {
      cwd: params.gitRoot,
    }).catch(() => null);
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
    candidateSha: tested.candidateSha,
    selectedDevUpstream,
    localDevBranchExists,
  };
}
