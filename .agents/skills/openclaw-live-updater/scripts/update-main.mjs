#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectChangedScope } from "../../../../scripts/ci-changed-scope.mjs";
import { isDirectRunUrl } from "../../../../scripts/lib/direct-run.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../../scripts/lib/local-build-metadata.mjs";
import {
  runNodeConfigFiles,
  runNodeSourceRoots,
} from "../../../../scripts/run-node-watch-paths.mjs";
import {
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
} from "../../../../scripts/run-node.mjs";

const DEFAULT_CHECKOUT = "/Users/steipete/openclaw";
const DEFAULT_EXPECTED_ORIGIN = "openclaw/openclaw";
const FULL_SHA_RE = /^[0-9a-f]{40}$/u;
const GATEWAY_READINESS_ATTEMPTS = 3;
const GATEWAY_READINESS_RETRY_DELAY_MS = 5_000;
const GATEWAY_STOP_PROOF_ATTEMPTS = 100;
const GATEWAY_STOP_PROOF_RETRY_DELAY_MS = 100;
const GATEWAY_SUSPEND_TIMEOUT_MS = 10_000;
const GENERATED_LAUNCH_AGENT_ENV_WRAPPER = `#!/bin/sh
set -eu
env_file="$1"
shift
if [ -f "$env_file" ]; then
  . "$env_file"
fi
exec "$@"
`;
const DEPENDENCY_INPUT_RE =
  /^(?:\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|patches\/)|(?:^|\/)package\.json$/u;

export class UpdateInvariantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateInvariantError";
    this.code = code;
  }
}

function git(checkout, args, options = {}) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function gitText(checkout, args) {
  return git(checkout, args).trim();
}

function configValue(checkout, key, bool = false) {
  try {
    return gitText(checkout, ["config", ...(bool ? ["--bool"] : ["--get"]), key]);
  } catch {
    return "";
  }
}

function githubSlug(remoteUrl) {
  const match = remoteUrl.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/iu,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function applicableUrlRewrite(checkout, remoteUrl) {
  let output;
  try {
    output = gitText(checkout, ["config", "--get-regexp", "^url\\..*\\.insteadOf$"]);
  } catch {
    return null;
  }
  return (
    output
      .split("\n")
      .map((line) => line.match(/^\S+\s+(.+)$/u)?.[1]?.trim())
      .filter(Boolean)
      .filter((prefix) => remoteUrl.startsWith(prefix))
      .toSorted((left, right) => right.length - left.length)[0] ?? null
  );
}

export function originMatches(remoteUrl) {
  return githubSlug(remoteUrl) === DEFAULT_EXPECTED_ORIGIN;
}

function changedPathsBetween(checkout, beforeSha, afterSha) {
  return git(checkout, ["diff", "--name-only", "-z", beforeSha, afterSha], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function commitExists(checkout, sha) {
  try {
    git(checkout, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestorCommit(checkout, ancestor, descendant = "HEAD") {
  try {
    git(checkout, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function classifyActions(
  changedPaths,
  { buildProvenanceKnown, buildRequired, nodeModulesPresent },
) {
  // CI skips generated protocol-only macOS jobs, but the live app embeds these Swift sources.
  const generatedMacProtocolChanged = changedPaths.some((changedPath) =>
    /^apps\/shared\/OpenClawKit\/Sources\/OpenClawProtocol\//u.test(changedPath),
  );
  const runMacos =
    changedPaths.length > 0 &&
    (detectChangedScope(changedPaths).runMacos || generatedMacProtocolChanged);
  const macUiVerification =
    runMacos &&
    changedPaths.some((changedPath) =>
      /^(?:apps\/macos\/Sources\/|apps\/shared\/OpenClawKit\/Sources\/|apps\/swabble\/Sources\/)/u.test(
        changedPath,
      ),
    );
  const dependencyInputsChanged = changedPaths.some((changedPath) =>
    DEPENDENCY_INPUT_RE.test(changedPath),
  );
  const dependencyInstall =
    !nodeModulesPresent || (buildRequired && (dependencyInputsChanged || !buildProvenanceKnown));
  return {
    dependencyInstall,
    gatewayBuild: buildRequired,
    gatewayProbe: true,
    gatewayRestart: buildRequired || dependencyInstall,
    gatewaySelfHeal: false,
    macAppRebuild: runMacos,
    macUiVerification,
  };
}

function readStampHead(checkout, stampFile) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(checkout, "dist", stampFile), "utf8"));
    return typeof parsed.head === "string" && FULL_SHA_RE.test(parsed.head.toLowerCase())
      ? parsed.head.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function canonicalBuildRequirements(checkout) {
  const distRoot = path.join(checkout, "dist");
  const fsImpl = { existsSync, readFileSync, readdirSync, statSync };
  const deps = {
    cwd: checkout,
    env: process.env,
    fs: fsImpl,
    spawnSync,
    distRoot,
    distEntry: path.join(distRoot, "entry.js"),
    buildStampPath: path.join(distRoot, BUILD_STAMP_FILE),
    runtimePostBuildStampPath: path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE),
    sourceRoots: runNodeSourceRoots.map((sourceRoot) => ({
      name: sourceRoot,
      path: path.join(checkout, sourceRoot),
    })),
    configFiles: runNodeConfigFiles.map((filePath) => path.join(checkout, filePath)),
  };
  return {
    build: resolveBuildRequirement(deps),
    runtimePostBuild: resolveRuntimePostBuildRequirement(deps),
  };
}

function missingControlUiAssets(checkout) {
  const root = path.join(checkout, "dist/control-ui");
  const indexPath = path.join(root, "index.html");
  let html;
  try {
    html = readFileSync(indexPath, "utf8");
  } catch {
    return ["index.html"];
  }
  const references = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/giu)]
    .map((match) => match[1].split(/[?#]/u, 1)[0])
    .filter(
      (reference) => reference && reference !== "/" && !/^(?:[a-z]+:|\/\/|#)/iu.test(reference),
    )
    .map((reference) => reference.replace(/^\.\//u, ""));
  const missing = references.filter((reference) => {
    const candidate = path.resolve(root, reference.replace(/^\//u, ""));
    return (
      !candidate.startsWith(`${root}${path.sep}`) ||
      !statSync(candidate, { throwIfNoEntry: false })?.isFile()
    );
  });
  const assetsDir = path.join(root, "assets");
  let hasAssetPayload = false;
  try {
    hasAssetPayload = readdirSync(assetsDir, { withFileTypes: true }).some((entry) =>
      entry.isFile(),
    );
  } catch {
    // Report the missing payload below.
  }
  if (!hasAssetPayload) {
    missing.push("assets/*");
  }
  return [...new Set(missing)].toSorted();
}

export function inspectBuildState(checkout, expectedSha) {
  const buildInfoPath = path.join(checkout, "dist/build-info.json");
  const uiPath = path.join(checkout, "dist/control-ui/index.html");
  let commit = null;
  try {
    const parsed = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    commit = typeof parsed.commit === "string" ? parsed.commit.toLowerCase() : null;
    if (!commit || !FULL_SHA_RE.test(commit)) {
      commit = null;
    }
  } catch {
    // Missing or invalid provenance is handled below.
  }
  const buildStampHead = readStampHead(checkout, BUILD_STAMP_FILE);
  const runtimePostBuildStampHead = readStampHead(checkout, RUNTIME_POSTBUILD_STAMP_FILE);
  const requirements = canonicalBuildRequirements(checkout);
  const missingUiAssets = missingControlUiAssets(checkout);
  const requiredFilesPresent =
    existsSync(buildInfoPath) && existsSync(uiPath) && missingUiAssets.length === 0;
  const current =
    requiredFilesPresent &&
    commit === expectedSha &&
    buildStampHead === expectedSha &&
    runtimePostBuildStampHead === expectedSha &&
    !requirements.build.shouldBuild &&
    !requirements.runtimePostBuild.shouldSync;
  const missingCanonicalOutput =
    !requiredFilesPresent ||
    requirements.build.reason.startsWith("missing_") ||
    requirements.runtimePostBuild.reason.startsWith("missing_");
  return {
    current,
    state: current ? "current" : missingCanonicalOutput ? "missing" : commit ? "stale" : "invalid",
    commit,
    buildStampHead,
    runtimePostBuildStampHead,
    missingUiAssets,
    requirements,
  };
}

export function verifyCheckout(checkout, { remote }) {
  let resolvedCheckout;
  try {
    resolvedCheckout = realpathSync(checkout);
  } catch {
    throw new UpdateInvariantError("checkout_missing", `checkout does not exist: ${checkout}`);
  }

  const gitDir = path.join(resolvedCheckout, ".git");
  const gitDirStat = lstatSync(gitDir, { throwIfNoEntry: false });
  if (!gitDirStat?.isDirectory() || gitDirStat.isSymbolicLink()) {
    throw new UpdateInvariantError(
      "not_standalone_clone",
      `checkout must contain its own .git directory: ${resolvedCheckout}`,
    );
  }
  if (
    realpathSync(gitText(resolvedCheckout, ["rev-parse", "--show-toplevel"])) !== resolvedCheckout
  ) {
    throw new UpdateInvariantError(
      "checkout_not_root",
      "checkout path must be the repository root",
    );
  }

  const commonDir = realpathSync(
    path.resolve(resolvedCheckout, gitText(resolvedCheckout, ["rev-parse", "--git-common-dir"])),
  );
  if (commonDir !== realpathSync(gitDir)) {
    throw new UpdateInvariantError("linked_worktree", "checkout uses a shared Git directory");
  }
  if (gitText(resolvedCheckout, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new UpdateInvariantError("shallow_clone", "checkout must be a full clone");
  }
  if (configValue(resolvedCheckout, "core.sparseCheckout", true) === "true") {
    throw new UpdateInvariantError("sparse_checkout", "checkout must not use sparse checkout");
  }
  if (
    configValue(resolvedCheckout, `remote.${remote}.promisor`, true) === "true" ||
    configValue(resolvedCheckout, "extensions.partialClone")
  ) {
    throw new UpdateInvariantError("partial_clone", "checkout must not use partial clone filters");
  }
  if (existsSync(path.join(gitDir, "objects/info/alternates"))) {
    throw new UpdateInvariantError("borrowed_objects", "checkout must own its Git objects");
  }

  const worktreeCount = gitText(resolvedCheckout, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  if (worktreeCount !== 1) {
    throw new UpdateInvariantError(
      "multiple_worktrees",
      `checkout must own exactly one worktree; found ${worktreeCount}`,
    );
  }

  const branch = gitText(resolvedCheckout, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") {
    throw new UpdateInvariantError("wrong_branch", `checkout must be on main; found ${branch}`);
  }
  if (gitText(resolvedCheckout, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new UpdateInvariantError("dirty_checkout", "checkout has tracked or untracked changes");
  }

  const remoteUrl = configValue(resolvedCheckout, `remote.${remote}.url`);
  if (!originMatches(remoteUrl)) {
    throw new UpdateInvariantError(
      "unexpected_origin",
      `${remote} points to ${remoteUrl}; expected ${DEFAULT_EXPECTED_ORIGIN}`,
    );
  }
  const rewrite = applicableUrlRewrite(resolvedCheckout, remoteUrl);
  if (rewrite) {
    throw new UpdateInvariantError(
      "rewritten_origin",
      `${remote} URL is affected by a Git insteadOf rewrite for ${rewrite}`,
    );
  }
  return {
    checkout: resolvedCheckout,
    branch,
    headSha: gitText(resolvedCheckout, ["rev-parse", "HEAD"]),
    remoteUrl,
  };
}

export function updateMain({ checkout, remote }, dependencies = {}) {
  const before = verifyCheckout(checkout, { remote });
  const fetchMain =
    dependencies.fetchMain ??
    ((target, remoteName) =>
      git(
        target,
        ["fetch", "--prune", remoteName, `refs/heads/main:refs/remotes/${remoteName}/main`],
        {
          stdio: ["ignore", "ignore", "inherit"],
        },
      ));
  fetchMain(before.checkout, remote);
  const afterFetch = verifyCheckout(before.checkout, { remote });
  if (afterFetch.headSha !== before.headSha) {
    throw new UpdateInvariantError(
      "concurrent_head_change",
      `HEAD changed during fetch: ${before.headSha} -> ${afterFetch.headSha}`,
    );
  }

  const remoteSha = gitText(before.checkout, ["rev-parse", `${remote}/main`]);
  git(before.checkout, ["merge", "--ff-only", `${remote}/main`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const after = verifyCheckout(before.checkout, { remote });
  if (after.headSha !== remoteSha) {
    throw new UpdateInvariantError(
      "local_main_diverged",
      `local main ${after.headSha} does not equal ${remote}/main ${remoteSha}`,
    );
  }
  const updated = before.headSha !== after.headSha;
  return {
    checkout: before.checkout,
    remote,
    branch: after.branch,
    beforeSha: before.headSha,
    afterSha: after.headSha,
    remoteSha,
    updated,
    changedPaths: updated
      ? changedPathsBetween(before.checkout, before.headSha, after.headSha)
      : [],
  };
}

function defaultLockPath(checkout) {
  const key = createHash("sha256").update(path.resolve(checkout)).digest("hex").slice(0, 12);
  return path.join(tmpdir(), `openclaw-live-updater-${key}.lock`);
}

function defaultStatePath(checkout) {
  return path.join(realpathSync(checkout), ".git", "openclaw-live-updater-state.json");
}

function readMaintenanceState(statePath) {
  if (!existsSync(statePath)) {
    return {};
  }
  try {
    const stat = lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("unsafe state file");
    }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch {
    throw new UpdateInvariantError(
      "invalid_state",
      `maintenance state is unreadable: ${statePath}`,
    );
  }
}

function writeMaintenanceState(statePath, state) {
  const directory = path.dirname(statePath);
  const temporary = path.join(directory, `.openclaw-live-updater-${process.pid}-${randomUUID()}`);
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireMaintenanceLock(checkout, requestedPath) {
  const lockPath = requestedPath ?? defaultLockPath(checkout);
  let incompleteLockRetries = 0;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let stat;
      try {
        stat = lstatSync(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UpdateInvariantError("unsafe_lock", `refusing unsafe lock path: ${lockPath}`);
      }
      let owner;
      try {
        owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      } catch (ownerError) {
        if (ownerError?.code === "ENOENT" && incompleteLockRetries < 20) {
          incompleteLockRetries += 1;
          spawnSync("sleep", ["0.01"]);
          continue;
        }
        throw new UpdateInvariantError("invalid_lock", `lock owner is unreadable: ${lockPath}`);
      }
      incompleteLockRetries = 0;
      if (Number.isInteger(owner.pid) && processAlive(owner.pid)) {
        return { acquired: false, lockPath, owner };
      }
      const staleClaim = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(lockPath, staleClaim);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") {
          continue;
        }
        throw renameError;
      }
      rmSync(staleClaim, { recursive: true });
    }
  }

  const owner = {
    pid: process.pid,
    checkout: path.resolve(checkout),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx" });
  return {
    acquired: true,
    lockPath,
    owner,
    release() {
      const current = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      if (current.pid !== process.pid) {
        throw new UpdateInvariantError("lock_owner_changed", "maintenance lock ownership changed");
      }
      rmSync(lockPath, { recursive: true });
    },
  };
}

function defaultRunCommand(command, args, checkout) {
  execFileSync(command, args, {
    cwd: checkout,
    stdio: ["ignore", process.stderr, process.stderr],
  });
}

function readSnapshotMetadata(snapshotRoot) {
  const gitDir = path.join(snapshotRoot, ".git");
  const headPath = path.join(gitDir, "HEAD");
  const configPath = path.join(gitDir, "config");
  const gitDirStat = lstatSync(gitDir);
  const headStat = lstatSync(headPath);
  const configStat = lstatSync(configPath);
  const owner = typeof process.getuid === "function" ? process.getuid() : null;
  const isTrustedMetadataFile = (filePath, fileStat) =>
    fileStat.isFile() &&
    !fileStat.isSymbolicLink() &&
    (owner === null || fileStat.uid === owner) &&
    (fileStat.mode & 0o022) === 0 &&
    realpathSync(filePath) === filePath;
  if (
    !gitDirStat.isDirectory() ||
    gitDirStat.isSymbolicLink() ||
    realpathSync(gitDir) !== gitDir ||
    !isTrustedMetadataFile(headPath, headStat) ||
    !isTrustedMetadataFile(configPath, configStat)
  ) {
    return null;
  }

  const head = readFileSync(headPath, "utf8").trim().toLowerCase();
  if (!FULL_SHA_RE.test(head)) {
    return null;
  }
  let inOrigin = false;
  let originUrl = null;
  for (const rawLine of readFileSync(configPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inOrigin = /^\[remote\s+"origin"\]$/u.test(line);
      continue;
    }
    if (!inOrigin) {
      continue;
    }
    const urlMatch = line.match(/^url\s*=\s*(.+)$/u);
    if (urlMatch) {
      originUrl = urlMatch[1].trim().replace(/^"(.*)"$/u, "$1");
      break;
    }
  }
  return originUrl ? { head, originUrl } : null;
}

export function isOwnedGatewayEntrypoint(checkout, home, entrypoint) {
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (entrypoint === sourceEntrypoint) {
    return true;
  }

  const runtimeRoot = path.join(home, ".openclaw/runtime");
  const snapshotRoot = path.dirname(path.dirname(entrypoint));
  const snapshotName = path.basename(snapshotRoot);
  if (
    path.dirname(snapshotRoot) !== runtimeRoot ||
    !/^gateway-[0-9a-f]{7}$/u.test(snapshotName) ||
    path.basename(path.dirname(entrypoint)) !== "dist" ||
    path.basename(entrypoint) !== "index.js"
  ) {
    return false;
  }

  try {
    const metadata = readSnapshotMetadata(snapshotRoot);
    const entrypointStat = lstatSync(entrypoint);
    const owner = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      realpathSync(snapshotRoot) !== snapshotRoot ||
      realpathSync(entrypoint) !== entrypoint ||
      !entrypointStat.isFile() ||
      entrypointStat.isSymbolicLink() ||
      (owner !== null && entrypointStat.uid !== owner) ||
      (entrypointStat.mode & 0o022) !== 0 ||
      !metadata ||
      !originMatches(metadata.originUrl)
    ) {
      return false;
    }
    const snapshotHead = metadata.head;
    if (
      !FULL_SHA_RE.test(snapshotHead) ||
      snapshotName !== `gateway-${snapshotHead.slice(0, 7)}` ||
      !commitExists(checkout, snapshotHead) ||
      !isAncestorCommit(checkout, snapshotHead)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveManagedGatewayCommand(
  programArguments,
  home,
  stateDir,
  label = "ai.openclaw.gateway",
) {
  if (!Array.isArray(programArguments)) {
    return null;
  }
  const defaultEnvDir = path.join(stateDir ?? path.join(home, ".openclaw"), "service-env");
  let envDir = defaultEnvDir;
  let envFilePath = null;
  let commandStartIndex = 0;
  let executable = programArguments[0];
  let prefix = [];
  let wrapperPath = null;
  const acceptsGeneratedWrapper = (candidateWrapper, candidateEnvFile) => {
    const candidateDir = path.dirname(candidateWrapper);
    return (
      path.basename(candidateDir) === "service-env" &&
      path.dirname(candidateEnvFile) === candidateDir &&
      path.basename(candidateWrapper) === `${label}-env-wrapper.sh` &&
      path.basename(candidateEnvFile) === `${label}.env`
    );
  };
  if (
    programArguments[0] === "/bin/sh" &&
    typeof programArguments[1] === "string" &&
    typeof programArguments[2] === "string" &&
    acceptsGeneratedWrapper(programArguments[1], programArguments[2])
  ) {
    wrapperPath = programArguments[1];
    envFilePath = programArguments[2];
    envDir = path.dirname(wrapperPath);
    commandStartIndex = 3;
    prefix = [wrapperPath, envFilePath];
  } else if (
    typeof programArguments[0] === "string" &&
    typeof programArguments[1] === "string" &&
    acceptsGeneratedWrapper(programArguments[0], programArguments[1])
  ) {
    wrapperPath = programArguments[0];
    envFilePath = programArguments[1];
    envDir = path.dirname(wrapperPath);
    commandStartIndex = 2;
    executable = wrapperPath;
    prefix = [envFilePath];
  }
  const runtime = programArguments[commandStartIndex];
  const entrypoint = programArguments[commandStartIndex + 1];
  const command = programArguments[commandStartIndex + 2];
  // Arbitrary --wrapper executables contain no checkout entrypoint, so their
  // ownership cannot be proven and conversion must remain a manual operation.
  return typeof runtime === "string" &&
    ["bun", "node"].includes(path.basename(runtime)) &&
    typeof entrypoint === "string" &&
    command === "gateway"
    ? {
        entrypoint,
        entrypointIndex: commandStartIndex + 1,
        envFilePath,
        executable,
        invocationPrefix: wrapperPath ? [...prefix, runtime, entrypoint] : [entrypoint],
        runtime,
        stateDir: path.dirname(envDir),
        wrapperPath,
      }
    : null;
}

export function resolveManagedGatewayEntrypoint(programArguments, home, stateDir) {
  return resolveManagedGatewayCommand(programArguments, home, stateDir)?.entrypoint ?? null;
}

function isTrustedGeneratedEnvironmentWrapper(command) {
  if (!command.wrapperPath || !command.envFilePath) {
    return true;
  }
  try {
    const wrapperStat = lstatSync(command.wrapperPath);
    const envFileStat = lstatSync(command.envFilePath);
    const owner = process.getuid();
    return (
      wrapperStat.isFile() &&
      !wrapperStat.isSymbolicLink() &&
      envFileStat.isFile() &&
      !envFileStat.isSymbolicLink() &&
      wrapperStat.uid === owner &&
      envFileStat.uid === owner &&
      (wrapperStat.mode & 0o022) === 0 &&
      (envFileStat.mode & 0o077) === 0 &&
      realpathSync(command.wrapperPath) === command.wrapperPath &&
      realpathSync(command.envFilePath) === command.envFilePath &&
      readFileSync(command.wrapperPath, "utf8") === GENERATED_LAUNCH_AGENT_ENV_WRAPPER
    );
  } catch {
    return false;
  }
}

function isTrustedOwnedRegularFile(fileStat) {
  return (
    fileStat.isFile() &&
    !fileStat.isSymbolicLink() &&
    fileStat.uid === process.getuid() &&
    (fileStat.mode & 0o022) === 0
  );
}

function readManagedGatewayLaunchAgent(checkout) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    throw new UpdateInvariantError(
      "gateway_launchagent_unavailable",
      "managed Gateway LaunchAgent inspection is only available on macOS",
    );
  }
  const home = process.env.HOME;
  if (!home) {
    throw new UpdateInvariantError("gateway_launchagent_failed", "HOME is unavailable");
  }
  const plistPath = path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
  let plistStat;
  try {
    plistStat = lstatSync(plistPath);
  } catch (error) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      `could not inspect the managed Gateway LaunchAgent: ${String(error)}`,
    );
  }
  if (!isTrustedOwnedRegularFile(plistStat)) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      "managed Gateway LaunchAgent is not a regular owned plist file",
    );
  }
  const plistResult = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
  });
  if (plistResult.status !== 0) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      `could not read the managed Gateway LaunchAgent: ${String(plistResult.stderr).trim()}`,
    );
  }
  const plist = JSON.parse(plistResult.stdout);
  const label = plist?.Label;
  const programArguments = plist?.ProgramArguments;
  const environmentVariables = plist?.EnvironmentVariables;
  const workingDirectory =
    typeof plist?.WorkingDirectory === "string" ? plist.WorkingDirectory : null;
  const serviceEnvironment = Object.fromEntries(
    Object.entries(environmentVariables ?? {}).filter((entry) => typeof entry[1] === "string"),
  );
  const stateDir =
    typeof environmentVariables?.OPENCLAW_STATE_DIR === "string"
      ? environmentVariables.OPENCLAW_STATE_DIR
      : path.join(home, ".openclaw");
  const gatewayCommand = resolveManagedGatewayCommand(programArguments, home, stateDir, label);
  const gatewayEntrypoint = gatewayCommand?.entrypoint ?? null;
  const ownsGatewayEntrypoint =
    gatewayEntrypoint !== null && isOwnedGatewayEntrypoint(checkout, home, gatewayEntrypoint);
  const portFlag = Array.isArray(programArguments) ? programArguments.indexOf("--port") : -1;
  const port = Number(portFlag >= 0 ? programArguments[portFlag + 1] : Number.NaN);
  if (
    typeof label !== "string" ||
    !Array.isArray(programArguments) ||
    !ownsGatewayEntrypoint ||
    !isTrustedGeneratedEnvironmentWrapper(gatewayCommand) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      "LaunchAgent does not describe this checkout's managed Gateway and port",
    );
  }
  const configPath =
    typeof plist?.EnvironmentVariables?.OPENCLAW_CONFIG_PATH === "string"
      ? plist.EnvironmentVariables.OPENCLAW_CONFIG_PATH
      : path.join(gatewayCommand.stateDir, "openclaw.json");
  return {
    configPath,
    entrypoint: gatewayEntrypoint,
    entrypointIndex: gatewayCommand.entrypointIndex,
    envFilePath: gatewayCommand.envFilePath,
    executable: gatewayCommand.executable,
    invocationPrefix: gatewayCommand.invocationPrefix,
    label,
    plistPath,
    port,
    runtime: gatewayCommand.runtime,
    serviceEnvironment,
    stateDir: gatewayCommand.stateDir,
    workingDirectory,
    wrapperPath: gatewayCommand.wrapperPath,
  };
}

function inspectManagedGatewayDeployment(checkout) {
  if (process.platform !== "darwin") {
    return null;
  }
  const home = process.env.HOME;
  if (!home || !existsSync(path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist"))) {
    return null;
  }
  return readManagedGatewayLaunchAgent(checkout);
}

export function repointManagedGatewayDeployment(
  checkout,
  deployment,
  replaceEntrypoint,
  inspectDeployment = inspectManagedGatewayDeployment,
) {
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (deployment.entrypoint === sourceEntrypoint) {
    return { changed: false, ...deployment };
  }
  replaceEntrypoint(deployment, sourceEntrypoint);
  const installed = inspectDeployment(checkout);
  if (
    !installed ||
    installed.configPath !== deployment.configPath ||
    installed.entrypoint !== sourceEntrypoint ||
    installed.label !== deployment.label ||
    installed.port !== deployment.port
  ) {
    throw new UpdateInvariantError(
      "gateway_repoint_failed",
      "managed Gateway LaunchAgent was not retargeted to the exact source build",
    );
  }
  return {
    changed: true,
    ...installed,
    previousEntrypoint: deployment.entrypoint,
  };
}

export function replaceLaunchAgentProgramArgument(programArguments, index, expected, replacement) {
  if (!Array.isArray(programArguments) || programArguments[index] !== expected) {
    throw new UpdateInvariantError(
      "gateway_repoint_failed",
      "managed Gateway LaunchAgent changed before its entrypoint could be replaced",
    );
  }
  return programArguments.with(index, replacement);
}

function replaceLaunchAgentEntrypoint(deployment, entrypoint) {
  const temporaryPath = `${deployment.plistPath}.openclaw-live-updater-${randomUUID()}`;
  writeFileSync(temporaryPath, readFileSync(deployment.plistPath), {
    flag: "wx",
    mode: statSync(deployment.plistPath).mode,
  });
  try {
    const plistResult = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", temporaryPath],
      { encoding: "utf8" },
    );
    if (plistResult.status !== 0) {
      throw new UpdateInvariantError(
        "gateway_repoint_failed",
        `could not read the managed Gateway LaunchAgent: ${String(plistResult.stderr).trim()}`,
      );
    }
    const programArguments = replaceLaunchAgentProgramArgument(
      JSON.parse(plistResult.stdout)?.ProgramArguments,
      deployment.entrypointIndex,
      deployment.entrypoint,
      entrypoint,
    );
    execFileSync(
      "/usr/bin/plutil",
      ["-replace", "ProgramArguments", "-json", JSON.stringify(programArguments), temporaryPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    execFileSync("/usr/bin/plutil", ["-lint", temporaryPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    renameSync(temporaryPath, deployment.plistPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function verifyManagedGatewayRuntime(checkout, expectedSha) {
  if (process.platform !== "darwin") {
    return null;
  }
  assertExactBuild(checkout, expectedSha);
  const deployment = inspectManagedGatewayDeployment(checkout);
  if (!deployment) {
    return null;
  }
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (deployment.entrypoint !== sourceEntrypoint) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "managed Gateway still targets an immutable ancestor snapshot after maintenance",
    );
  }
  const launchctl = spawnSync(
    "/bin/launchctl",
    ["print", `gui/${process.getuid()}/${deployment.label}`],
    { encoding: "utf8" },
  );
  const pidMatch =
    launchctl.status === 0 ? String(launchctl.stdout).match(/\bpid = (\d+)\b/u) : null;
  const pid = Number(pidMatch?.[1] ?? Number.NaN);
  const loadedArguments = parseLaunchctlArguments(String(launchctl.stdout));
  const loadedCommand = resolveManagedGatewayCommand(
    loadedArguments,
    process.env.HOME,
    deployment.stateDir,
    deployment.label,
  );
  const loadedPortFlag = loadedArguments.indexOf("--port");
  const loadedPort = Number(loadedPortFlag >= 0 ? loadedArguments[loadedPortFlag + 1] : Number.NaN);
  if (
    !loadedCommand ||
    loadedCommand.entrypoint !== sourceEntrypoint ||
    loadedCommand.executable !== deployment.executable ||
    loadedCommand.runtime !== deployment.runtime ||
    loadedCommand.wrapperPath !== deployment.wrapperPath ||
    loadedPort !== deployment.port
  ) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "loaded Gateway LaunchAgent arguments do not use the exact source entrypoint",
    );
  }
  if (!Number.isInteger(pid) || pid < 1) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "managed Gateway LaunchAgent has no running process after maintenance",
    );
  }
  const listeners = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${deployment.port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  const listenerPids = String(listeners.stdout).trim().split(/\s+/u).filter(Boolean).map(Number);
  // The Gateway overwrites process.title, so ps cannot prove argv. The owned
  // LaunchAgent arguments plus its exact listener PID remain stable evidence.
  if (listeners.status !== 0 || !listenerPids.includes(pid)) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "managed Gateway LaunchAgent PID does not own its configured listener",
    );
  }
  return { commit: expectedSha, entrypoint: sourceEntrypoint, pid, port: deployment.port };
}

export function parseLaunchctlArguments(output) {
  const block = output.match(/\n\s*arguments = \{\n(?<body>[\s\S]*?)\n\s*\}/u)?.groups?.body;
  return block
    ? block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function runBuiltGatewayCli(checkout, args, deployment, options = {}) {
  const observedDeployment = deployment ?? readManagedGatewayLaunchAgent(checkout);
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  let managedDeployment = observedDeployment;
  if (observedDeployment.entrypoint !== sourceEntrypoint) {
    const currentHead = gitText(checkout, ["rev-parse", "HEAD"]);
    managedDeployment = resolveGatewayControlDeployment(
      checkout,
      observedDeployment,
      inspectBuildState(checkout, currentHead),
      currentHead,
    );
    if (!managedDeployment) {
      throw new UpdateInvariantError(
        "gateway_snapshot_control_unavailable",
        "refusing to execute a managed Gateway runtime snapshot without a trusted source control build",
      );
    }
  }
  const {
    configPath,
    entrypoint,
    envFilePath,
    executable,
    invocationPrefix,
    port,
    runtime,
    serviceEnvironment = {},
    workingDirectory,
    wrapperPath,
  } = managedDeployment;
  const baseEnv = { ...process.env };
  delete baseEnv.OPENCLAW_GATEWAY_URL;
  delete baseEnv.OPENCLAW_GATEWAY_TOKEN;
  delete baseEnv.OPENCLAW_GATEWAY_PASSWORD;
  delete baseEnv.OPENCLAW_CONFIG_PATH;
  delete baseEnv.OPENCLAW_GATEWAY_PORT;
  Object.assign(baseEnv, serviceEnvironment);
  delete baseEnv.OPENCLAW_GATEWAY_URL;
  let effectiveConfigPath = configPath;
  if (wrapperPath && envFilePath) {
    delete baseEnv.OPENCLAW_CONFIG_PATH;
    delete baseEnv.OPENCLAW_GATEWAY_PORT;
    const wrapperPrefix = executable === "/bin/sh" ? [wrapperPath, envFilePath] : [envFilePath];
    try {
      const configuredPath = execFileSync(
        executable,
        [...wrapperPrefix, "/usr/bin/printenv", "OPENCLAW_CONFIG_PATH"],
        { encoding: "utf8", env: baseEnv, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (configuredPath) {
        effectiveConfigPath = configuredPath;
      }
    } catch {
      // The service environment may rely on the state-directory default.
    }
  }
  const overlayPath = path.join(
    path.dirname(effectiveConfigPath),
    `.openclaw-live-updater-config-${randomUUID()}.json`,
  );
  writeFileSync(
    overlayPath,
    `${JSON.stringify({
      $include: `./${path.basename(effectiveConfigPath)}`,
      gateway: { mode: "local", port },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const envOverrides = [`OPENCLAW_CONFIG_PATH=${overlayPath}`, `OPENCLAW_GATEWAY_PORT=${port}`];
  const env = Object.assign(baseEnv, {
    OPENCLAW_CONFIG_PATH: overlayPath,
    OPENCLAW_GATEWAY_PORT: String(port),
  });
  try {
    const callArgs =
      wrapperPath && envFilePath
        ? [
            ...(executable === "/bin/sh" ? [wrapperPath, envFilePath] : [envFilePath]),
            "/usr/bin/env",
            "-u",
            "OPENCLAW_GATEWAY_URL",
            ...envOverrides,
            runtime,
            entrypoint,
            ...args,
          ]
        : [...invocationPrefix, ...args];
    return execFileSync(executable, callArgs, {
      cwd: workingDirectory ?? path.dirname(path.dirname(entrypoint)),
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", options.stderr ?? "inherit"],
    });
  } finally {
    rmSync(overlayPath, { force: true });
  }
}

export function runBuiltGatewayCall(checkout, method, params, deployment) {
  const managedDeployment = deployment ?? readManagedGatewayLaunchAgent(checkout);
  return runBuiltGatewayCli(
    checkout,
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      String(GATEWAY_SUSPEND_TIMEOUT_MS),
    ],
    managedDeployment,
  );
}

export function prepareGatewaySuspension(
  checkout,
  callGateway = runBuiltGatewayCall,
  deployment = null,
) {
  const requestId = `openclaw-live-updater-${randomUUID()}`;
  let result;
  try {
    result = JSON.parse(
      callGateway(checkout, "gateway.suspend.prepare", { requestId }, deployment),
    );
  } catch (error) {
    throw new UpdateInvariantError(
      "gateway_suspend_prepare_failed",
      `could not atomically prepare Gateway maintenance: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result?.status === "ready" && typeof result.suspensionId === "string") {
    return result;
  }
  if (result?.status === "busy" && Array.isArray(result.blockers)) {
    return result;
  }
  throw new UpdateInvariantError(
    "gateway_suspend_prepare_invalid",
    `Gateway returned an invalid suspension result: ${JSON.stringify(result)}`,
  );
}

function defaultResumeGatewaySuspension(checkout, suspensionId, deployment) {
  runBuiltGatewayCall(checkout, "gateway.suspend.resume", { suspensionId }, deployment);
}

function stopManagedGateway(runCommand, checkout, deployment) {
  if (!deployment) {
    runCommand(process.execPath, ["dist/index.js", "gateway", "stop"], checkout);
    return;
  }
  runCommand(
    "/bin/launchctl",
    ["bootout", `gui/${process.getuid()}/${deployment.label}`],
    checkout,
  );
}

function stopManagedGatewayAndProve(runCommand, checkout, deployment, proveGatewayStopped, sleep) {
  let stopError;
  try {
    stopManagedGateway(runCommand, checkout, deployment);
  } catch (error) {
    stopError = error;
  }
  let proofError;
  for (let attempt = 0; attempt < GATEWAY_STOP_PROOF_ATTEMPTS; attempt += 1) {
    try {
      return proveGatewayStopped(checkout);
    } catch (error) {
      proofError = error;
      if (attempt + 1 < GATEWAY_STOP_PROOF_ATTEMPTS) {
        sleep(GATEWAY_STOP_PROOF_RETRY_DELAY_MS);
      }
    }
  }
  if (!stopError) {
    throw proofError;
  }
  throw new AggregateError(
    [stopError, proofError],
    "Gateway stop command failed and native stopped proof did not converge",
  );
}

function isTrustedSourceControlBuild(checkout, buildState, currentHead) {
  if (buildState.current) {
    return true;
  }
  const commit = buildState.commit;
  if (
    buildState.state !== "stale" ||
    !commit ||
    buildState.buildStampHead !== commit ||
    buildState.runtimePostBuildStampHead !== commit ||
    buildState.missingUiAssets.length > 0 ||
    !commitExists(checkout, commit)
  ) {
    return false;
  }
  try {
    git(checkout, ["merge-base", "--is-ancestor", commit, currentHead]);
    return true;
  } catch {
    return false;
  }
}

function resolveGatewayControlDeployment(checkout, deployment, buildBefore, currentHead) {
  if (!deployment) {
    return null;
  }
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (deployment.entrypoint === sourceEntrypoint) {
    return deployment;
  }
  if (!isTrustedSourceControlBuild(checkout, buildBefore, currentHead)) {
    return null;
  }
  return {
    ...deployment,
    entrypoint: sourceEntrypoint,
    invocationPrefix: deployment.invocationPrefix.map((argument) =>
      argument === deployment.entrypoint ? sourceEntrypoint : argument,
    ),
  };
}

function proveMacLaunchdGatewayStopped(checkout) {
  const { label, port } = readManagedGatewayLaunchAgent(checkout);
  const launchctl = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], {
    encoding: "utf8",
  });
  const launchctlOutput = `${launchctl.stdout ?? ""}\n${launchctl.stderr ?? ""}`;
  const serviceBootedOut =
    launchctl.status !== 0 && /could not find service|service not found/iu.test(launchctlOutput);
  if (!serviceBootedOut) {
    throw new UpdateInvariantError(
      "gateway_not_proven_stopped",
      "managed Gateway LaunchAgent is still loaded or its bootout state is ambiguous",
    );
  }
  const listeners = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  if (
    listeners.status !== 1 ||
    String(listeners.stdout).trim() ||
    String(listeners.stderr).trim()
  ) {
    throw new UpdateInvariantError(
      "gateway_not_proven_stopped",
      `Gateway port ${port} is listening or could not be inspected conclusively`,
    );
  }
  return { runtimeStatus: "stopped", port, portStatus: "free", proofSource: "launchd" };
}

function defaultProveGatewayStopped(checkout) {
  if (process.platform === "darwin") {
    return proveMacLaunchdGatewayStopped(checkout);
  }
  let result;
  try {
    result = JSON.parse(
      execFileSync(process.execPath, ["dist/index.js", "gateway", "status", "--json"], {
        cwd: checkout,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
  } catch (error) {
    throw new UpdateInvariantError(
      "gateway_stopped_proof_failed",
      `could not inspect the managed Gateway after suspension failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const runtime = result?.service?.runtime;
  const port = result?.port;
  if (
    runtime?.status !== "stopped" ||
    runtime.pid != null ||
    port?.status !== "free" ||
    !Array.isArray(port.listeners) ||
    port.listeners.length > 0 ||
    result?.rpc?.ok === true
  ) {
    throw new UpdateInvariantError(
      "gateway_not_proven_stopped",
      `managed Gateway is not conclusively stopped: ${JSON.stringify({
        runtimeStatus: runtime?.status ?? null,
        runtimePid: runtime?.pid ?? null,
        portStatus: port?.status ?? null,
        listenerCount: Array.isArray(port?.listeners) ? port.listeners.length : null,
        rpcOk: result?.rpc?.ok ?? null,
      })}`,
    );
  }
  return {
    runtimeStatus: runtime.status,
    port: port.port ?? null,
    portStatus: port.status,
  };
}

function assertExactBuild(checkout, expectedSha) {
  const state = inspectBuildState(checkout, expectedSha);
  if (!state.current) {
    throw new UpdateInvariantError(
      "build_sha_mismatch",
      `build output does not match ${expectedSha}; state=${state.state}`,
    );
  }
  return state;
}

function isOriginalMacBundle(bundlePath, originalStat) {
  try {
    const currentStat = lstatSync(bundlePath);
    return (
      currentStat.isDirectory() &&
      !currentStat.isSymbolicLink() &&
      currentStat.dev === originalStat.dev &&
      currentStat.ino === originalStat.ino
    );
  } catch {
    return false;
  }
}

function runBuildWithPreservedMacApp(runCommand, checkout, sleep = defaultSleep) {
  const appBundle = path.join(checkout, "dist/OpenClaw.app");
  if (!existsSync(appBundle)) {
    runCommand("pnpm", ["build"], checkout);
    return;
  }
  const appStat = lstatSync(appBundle);
  if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
    throw new UpdateInvariantError(
      "unsafe_mac_bundle",
      `refusing to preserve unsafe Mac app bundle: ${appBundle}`,
    );
  }
  const preservedBundle = path.join(
    checkout,
    ".git",
    `.openclaw-live-mac-${process.pid}-${randomUUID()}.app`,
  );
  renameSync(appBundle, preservedBundle);
  try {
    runCommand("pnpm", ["build"], checkout);
  } finally {
    // A running app or external file coordinator can temporarily relocate and
    // restore the exact bundle while the JS build runs. Allow that move to settle, but
    // require the original inode so an unrelated replacement still fails closed.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (existsSync(preservedBundle) || existsSync(appBundle)) {
        break;
      }
      sleep(100);
    }
    const alreadyRestored = isOriginalMacBundle(appBundle, appStat);
    if (!alreadyRestored && existsSync(appBundle)) {
      throw new UpdateInvariantError(
        "mac_bundle_restore_conflict",
        `build unexpectedly created ${appBundle}; preserved bundle remains at ${preservedBundle}`,
      );
    }
    if (!alreadyRestored) {
      mkdirSync(path.dirname(appBundle), { recursive: true });
      try {
        renameSync(preservedBundle, appBundle);
      } catch (error) {
        if (!isOriginalMacBundle(appBundle, appStat)) {
          if (existsSync(appBundle)) {
            throw new UpdateInvariantError(
              "mac_bundle_restore_conflict",
              `build unexpectedly created ${appBundle}; preserved bundle remains at ${preservedBundle}`,
            );
          }
          if (existsSync(preservedBundle)) {
            throw new UpdateInvariantError(
              "mac_bundle_restore_failed",
              `failed to restore Mac app bundle: ${String(error)}`,
            );
          }
          throw new UpdateInvariantError(
            "missing_preserved_mac_bundle",
            `preserved Mac app bundle disappeared: ${preservedBundle}`,
          );
        }
      }
    }
    if (!isOriginalMacBundle(appBundle, appStat)) {
      throw new UpdateInvariantError(
        "missing_preserved_mac_bundle",
        `original Mac app bundle was not restored to ${appBundle}`,
      );
    }
    if (existsSync(preservedBundle)) {
      throw new UpdateInvariantError(
        "mac_bundle_restore_conflict",
        `original Mac app bundle exists at both ${appBundle} and ${preservedBundle}`,
      );
    }
  }
}

function restartGateway(
  runCommand,
  checkout,
  expectedSha,
  startedAtMs = Date.now(),
  deployment = null,
  bootstrap = false,
) {
  assertExactBuild(checkout, expectedSha);
  if (!deployment) {
    runCommand("pnpm", ["openclaw", "gateway", "restart"], checkout);
    return startedAtMs;
  }
  if (bootstrap) {
    const plistStat = lstatSync(deployment.plistPath);
    if (!isTrustedOwnedRegularFile(plistStat)) {
      throw new UpdateInvariantError(
        "gateway_launchagent_failed",
        "managed Gateway LaunchAgent ownership or permissions changed before bootstrap",
      );
    }
    const domain = `gui/${process.getuid()}`;
    runCommand("/bin/launchctl", ["enable", `${domain}/${deployment.label}`], checkout);
    runCommand("/bin/launchctl", ["bootstrap", domain, deployment.plistPath], checkout);
    return startedAtMs;
  }
  runCommand(
    deployment.executable,
    [...deployment.invocationPrefix, "gateway", "restart"],
    path.dirname(path.dirname(deployment.entrypoint)),
  );
  return startedAtMs;
}

function isManagedGatewayLoaded(deployment) {
  const result = spawnSync(
    "/bin/launchctl",
    ["print", `gui/${process.getuid()}/${deployment.label}`],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

function verifyGateway(runCommand, checkout, expectedSha, deployment = null) {
  assertExactBuild(checkout, expectedSha);
  if (deployment) {
    runBuiltGatewayCli(
      checkout,
      ["gateway", "status", "--deep", "--require-rpc", "--json"],
      deployment,
    );
    runBuiltGatewayCli(
      checkout,
      ["health", "--port", String(deployment.port), "--verbose", "--json"],
      deployment,
    );
    return;
  }
  runCommand(
    "pnpm",
    ["openclaw", "gateway", "status", "--deep", "--require-rpc", "--json"],
    checkout,
  );
  runCommand("pnpm", ["openclaw", "health", "--verbose", "--json"], checkout);
}

function defaultSleep(ms) {
  execFileSync("sleep", [String(ms / 1_000)]);
}

export function verifyGatewayReadiness(
  runCommand,
  checkout,
  expectedSha,
  sleep = defaultSleep,
  deployment = null,
) {
  let lastError;
  for (let attempt = 1; attempt <= GATEWAY_READINESS_ATTEMPTS; attempt += 1) {
    try {
      verifyGateway(runCommand, checkout, expectedSha, deployment);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < GATEWAY_READINESS_ATTEMPTS) {
        sleep(GATEWAY_READINESS_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function summarizeGatewayLogEntry(entry) {
  return {
    time: entry.time,
    level: entry.level,
    subsystem: entry.subsystem ?? null,
    message: String(entry.message ?? "").slice(0, 500),
  };
}

function canonicalizeExistingPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathWithinRoot(sourcePath, rootPath) {
  const normalizedRoot = canonicalizeExistingPath(rootPath);
  const normalizedSource = canonicalizeExistingPath(sourcePath);
  return (
    normalizedSource === normalizedRoot ||
    normalizedSource.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function isCurrentGatewayLogSource(source, sourceRoot, managedSourceRoots) {
  if (managedSourceRoots === null) {
    return true;
  }
  if (!sourceRoot) {
    return true;
  }
  if (typeof source !== "string" || source.length === 0) {
    return true;
  }
  let sourcePath;
  try {
    sourcePath = source.startsWith("file:") ? fileURLToPath(source) : source;
  } catch {
    return true;
  }
  const sourceFilePath = sourcePath.replace(/:\d+(?::\d+)?$/u, "");
  if (sourceFilePath !== sourcePath && !existsSync(sourcePath) && existsSync(sourceFilePath)) {
    sourcePath = sourceFilePath;
  }
  if (
    isPathWithinRoot(sourcePath, sourceRoot) ||
    managedSourceRoots.some((rootPath) => isPathWithinRoot(sourcePath, rootPath))
  ) {
    return true;
  }
  const normalizedRoot = canonicalizeExistingPath(sourceRoot);
  const normalizedSource = canonicalizeExistingPath(sourcePath);
  const checkoutRoot = path.dirname(normalizedRoot);
  let candidate = path.dirname(normalizedSource);
  while (candidate !== path.dirname(candidate)) {
    const packagePath = path.join(candidate, "package.json");
    const gitPath = path.join(candidate, ".git");
    if (existsSync(packagePath) && existsSync(gitPath)) {
      try {
        if (JSON.parse(readFileSync(packagePath, "utf8")).name === "openclaw") {
          return candidate === checkoutRoot;
        }
      } catch {
        return true;
      }
    }
    candidate = path.dirname(candidate);
  }
  return true;
}

function parseGatewayLogEntries(output, sinceMs) {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const raw = JSON.parse(line);
        let sourceRecord = raw;
        if (raw.type === "log" && typeof raw.raw === "string") {
          try {
            sourceRecord = JSON.parse(raw.raw);
          } catch {
            sourceRecord = raw;
          }
        }
        const rawLevel = raw.type === "log" ? raw.level : raw._meta?.logLevelName;
        const level = String(rawLevel ?? "").toLowerCase();
        const time = raw.time ?? raw._meta?.date;
        const timestamp = Date.parse(time ?? "");
        if (!level || !Number.isFinite(timestamp) || timestamp < sinceMs) {
          return [];
        }
        let subsystem = raw.subsystem ?? null;
        if (!subsystem && typeof raw["0"] === "string") {
          try {
            subsystem = JSON.parse(raw["0"]).subsystem ?? null;
          } catch {
            subsystem = null;
          }
        }
        return [
          {
            time,
            level,
            subsystem,
            message: raw.message ?? raw["1"] ?? raw["0"] ?? "",
            source: sourceRecord._meta?.path?.fullFilePath ?? null,
          },
        ];
      } catch {
        return [];
      }
    });
}

function summarizeGatewayLogAudit(entries) {
  const errors = entries
    .filter((entry) => entry.level === "error" || entry.level === "fatal")
    .map(summarizeGatewayLogEntry);
  const warnings = entries.filter((entry) => entry.level === "warn").map(summarizeGatewayLogEntry);
  return {
    entries: entries.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 20),
  };
}

export function parseGatewayLogAudit(output, sinceMs, sourceRoot = null, managedSourceRoots = []) {
  const entries = parseGatewayLogEntries(output, sinceMs).filter((entry) =>
    isCurrentGatewayLogSource(entry.source, sourceRoot, managedSourceRoots),
  );
  return summarizeGatewayLogAudit(entries);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readFallbackGatewayLogs(sinceMs) {
  const dates = new Set([localDateKey(new Date(sinceMs)), localDateKey(new Date())]);
  const directories = new Set(["/tmp/openclaw", path.join(tmpdir(), "openclaw")]);
  const contents = [];
  for (const directory of directories) {
    for (const date of dates) {
      const logPath = path.join(directory, `openclaw-${date}.log`);
      if (existsSync(logPath)) {
        contents.push(readFileSync(logPath, "utf8"));
      }
    }
  }
  return contents.join("\n");
}

function readManagedPluginSourceRoots(checkout, deployment) {
  let managedDeployment = deployment;
  try {
    managedDeployment ??= readManagedGatewayLaunchAgent(checkout);
  } catch {
    return null;
  }
  try {
    const output = runBuiltGatewayCli(
      checkout,
      ["plugins", "list", "--enabled", "--json"],
      managedDeployment,
      { stderr: "pipe" },
    );
    return resolveManagedPluginSourceRoots(JSON.parse(output));
  } catch {
    return null;
  }
}

export function resolveManagedPluginSourceRoots(report) {
  if (!Array.isArray(report?.plugins)) {
    return null;
  }
  const roots = [];
  for (const plugin of report.plugins) {
    if (typeof plugin?.rootDir !== "string" || plugin.rootDir.length === 0) {
      return null;
    }
    roots.push(plugin.rootDir);
  }
  return roots;
}

export function resolveManagedGatewaySourceRoot(checkout, deployment) {
  return typeof deployment?.entrypoint === "string" && deployment.entrypoint.length > 0
    ? path.dirname(path.resolve(deployment.entrypoint))
    : path.join(realpathSync(checkout), "dist");
}

function defaultAuditGatewayLogs(checkout, sinceMs, deployment = null) {
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [
        "openclaw.mjs",
        "logs",
        "--json",
        "--limit",
        "1000",
        "--max-bytes",
        "1000000",
        "--timeout",
        "10000",
      ],
      { cwd: checkout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    output = readFallbackGatewayLogs(sinceMs);
    if (!output) {
      throw error;
    }
  }
  const audit = parseGatewayLogAudit(
    output,
    sinceMs,
    resolveManagedGatewaySourceRoot(checkout, deployment),
    readManagedPluginSourceRoots(checkout, deployment),
  );
  if (audit.errorCount > 0) {
    throw new UpdateInvariantError(
      "gateway_restart_log_errors",
      `Gateway emitted ${audit.errorCount} error/fatal log entries after restart: ${JSON.stringify(audit.errors.slice(0, 5))}`,
    );
  }
  return audit;
}

function verifyAndAuditGateway({
  runCommand,
  auditGatewayLogs,
  checkout,
  expectedSha,
  deployment,
  sinceMs,
  sleep,
}) {
  let verificationError;
  try {
    verifyGatewayReadiness(runCommand, checkout, expectedSha, sleep, deployment);
  } catch (error) {
    verificationError = error;
  }
  const audit = auditGatewayLogs(checkout, sinceMs, deployment);
  if (verificationError) {
    throw verificationError;
  }
  return audit;
}

export function findExactMacTarget(processes, executable) {
  const target = processes
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/u))
    .find((match) => match && (match[2] === executable || match[2].startsWith(`${executable} `)));
  return target ? { executable, pid: Number(target[1]) } : null;
}

function defaultVerifyMacTarget(checkout) {
  execFileSync("sleep", ["10"]);
  const executable = path.join(checkout, "dist/OpenClaw.app/Contents/MacOS/OpenClaw");
  const processes = execFileSync("ps", ["axww", "-o", "pid=,command="], {
    encoding: "utf8",
  });
  const target = findExactMacTarget(processes, executable);
  if (!target) {
    throw new UpdateInvariantError(
      "mac_target_not_alive",
      `exact target bundle exited after delayed verification: ${executable}`,
    );
  }
  return target;
}

export function maintainMain(options, dependencies = {}) {
  const lock = acquireMaintenanceLock(options.checkout, options.lockPath);
  if (!lock.acquired) {
    return {
      schemaVersion: 1,
      ok: true,
      skipped: true,
      reason: "overlap",
      lock: { path: lock.lockPath, ownerPid: lock.owner.pid, startedAt: lock.owner.startedAt },
    };
  }

  try {
    const verifiedBefore = verifyCheckout(options.checkout, { remote: options.remote });
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    const inspectGatewayDeployment =
      dependencies.inspectGatewayDeployment ?? inspectManagedGatewayDeployment;
    const repointGatewayDeployment =
      dependencies.repointGatewayDeployment ?? repointManagedGatewayDeployment;
    const replaceGatewayEntrypoint =
      dependencies.replaceGatewayEntrypoint ?? replaceLaunchAgentEntrypoint;
    const verifyGatewayRuntime = dependencies.verifyGatewayRuntime ?? verifyManagedGatewayRuntime;
    const verifyGatewayProbe = dependencies.verifyGateway ?? verifyGateway;
    const verifyGatewayAfterRestart = dependencies.verifyAndAuditGateway ?? verifyAndAuditGateway;
    const isGatewayLoaded = dependencies.isGatewayLoaded ?? isManagedGatewayLoaded;
    const prepareSuspension =
      dependencies.prepareGatewaySuspension ??
      ((checkout, deployment) =>
        prepareGatewaySuspension(checkout, runBuiltGatewayCall, deployment));
    const resumeSuspension = dependencies.resumeGatewaySuspension ?? defaultResumeGatewaySuspension;
    const proveGatewayStopped = dependencies.proveGatewayStopped ?? defaultProveGatewayStopped;
    const verifyMacTarget = dependencies.verifyMacTarget ?? defaultVerifyMacTarget;
    const auditGatewayLogs = dependencies.auditGatewayLogs ?? defaultAuditGatewayLogs;
    const sleep = dependencies.sleep ?? defaultSleep;
    const gatewayDeploymentBefore = inspectGatewayDeployment(verifiedBefore.checkout);
    const sourceBuildBeforeUpdate = inspectBuildState(
      verifiedBefore.checkout,
      verifiedBefore.headSha,
    );
    let gatewayControlDeployment = resolveGatewayControlDeployment(
      verifiedBefore.checkout,
      gatewayDeploymentBefore,
      sourceBuildBeforeUpdate,
      verifiedBefore.headSha,
    );
    const update = updateMain(options, dependencies);
    const statePath = options.statePath ?? defaultStatePath(update.checkout);
    const maintenanceState = readMaintenanceState(statePath);
    const buildBefore = inspectBuildState(update.checkout, update.afterSha);
    const buildRequired = update.updated || !buildBefore.current;
    let buildChangedPaths = update.changedPaths;
    const buildBaseExists =
      Boolean(buildBefore.commit) && commitExists(update.checkout, buildBefore.commit);
    if (
      buildRequired &&
      buildBefore.commit &&
      buildBefore.commit !== update.afterSha &&
      buildBaseExists
    ) {
      buildChangedPaths = changedPathsBetween(update.checkout, buildBefore.commit, update.afterSha);
    }
    const actions = classifyActions(buildChangedPaths, {
      buildProvenanceKnown: buildBefore.current || buildBaseExists,
      buildRequired,
      nodeModulesPresent: existsSync(path.join(update.checkout, "node_modules")),
    });
    if (maintenanceState.macPending) {
      actions.macAppRebuild = true;
      actions.macUiVerification ||= maintenanceState.macUiVerification === true;
    }
    const gatewayRuntimeRepointRequired =
      gatewayDeploymentBefore !== null &&
      gatewayDeploymentBefore.entrypoint !== path.join(update.checkout, "dist/index.js");
    let gatewayLogAudit = null;
    let gatewayDeployment = null;
    let gatewayRuntime = null;
    let queuedMacState = null;
    if (actions.macAppRebuild) {
      queuedMacState = {
        macPending: true,
        macUiVerification: actions.macUiVerification,
        sinceSha: maintenanceState.sinceSha ?? update.afterSha,
        attempts: Number(maintenanceState.attempts ?? 0),
        queuedAt: maintenanceState.queuedAt ?? new Date().toISOString(),
      };
      writeMaintenanceState(statePath, queuedMacState);
    }

    if (actions.gatewayBuild || actions.dependencyInstall || gatewayRuntimeRepointRequired) {
      actions.gatewayRestart = true;
      let controlBuildPrepared = false;
      let controlDependenciesInstalled = false;
      let gatewaySuspension;
      const controlUnavailable =
        gatewayDeploymentBefore !== null && gatewayControlDeployment === null;
      if (controlUnavailable) {
        try {
          gatewaySuspension = {
            status: "offline",
            proof: proveGatewayStopped(update.checkout),
          };
        } catch (proofError) {
          try {
            if (!gatewayRuntimeRepointRequired) {
              throw new UpdateInvariantError(
                "gateway_live_source_build_forbidden",
                "refusing to rebuild the source entrypoint while its managed Gateway is still running",
              );
            }
            // The running Gateway is isolated in its immutable snapshot, so a
            // clean source build cannot mutate its code. Build only to obtain
            // an exact trusted client for the suspension RPC.
            if (actions.dependencyInstall) {
              runCommand("pnpm", ["install", "--frozen-lockfile"], update.checkout);
              controlDependenciesInstalled = true;
            }
            if (!actions.gatewayBuild) {
              throw new UpdateInvariantError(
                "gateway_snapshot_control_unavailable",
                "managed Gateway snapshot has no exact trusted source control build",
              );
            }
            runBuildWithPreservedMacApp(runCommand, update.checkout, sleep);
            assertExactBuild(update.checkout, update.afterSha);
            controlBuildPrepared = true;
            gatewayControlDeployment = resolveGatewayControlDeployment(
              update.checkout,
              gatewayDeploymentBefore,
              inspectBuildState(update.checkout, update.afterSha),
              update.afterSha,
            );
            if (!gatewayControlDeployment) {
              throw new UpdateInvariantError(
                "gateway_snapshot_control_unavailable",
                "source build did not produce an exact trusted Gateway control client",
              );
            }
            gatewaySuspension = prepareSuspension(update.checkout, gatewayControlDeployment);
          } catch (controlError) {
            throw new AggregateError(
              [
                new UpdateInvariantError(
                  "gateway_snapshot_control_unavailable",
                  "managed Gateway uses a snapshot but the source checkout has no exact trusted control build",
                ),
                proofError,
                controlError,
              ],
              "Gateway control is unavailable and the managed Gateway could not be proven stopped",
            );
          }
        }
      } else {
        try {
          gatewaySuspension = prepareSuspension(update.checkout, gatewayControlDeployment);
        } catch (prepareError) {
          try {
            gatewaySuspension = {
              status: "offline",
              proof: proveGatewayStopped(update.checkout),
            };
          } catch (proofError) {
            throw new AggregateError(
              [prepareError, proofError],
              "Gateway suspension failed and the managed Gateway could not be proven stopped",
            );
          }
        }
      }
      if (gatewaySuspension.status === "busy") {
        return {
          schemaVersion: 1,
          ok: true,
          deferred: true,
          reason: "gateway_active_work",
          ...update,
          buildBefore,
          buildChangedPaths,
          actions,
          gatewaySuspension,
        };
      }
      if (gatewaySuspension.status === "ready") {
        // Native bootout prevents launchd from retaining old ProgramArguments
        // and avoids source launchers that can rebuild stale dist before stopping.
        try {
          // launchctl can return before the job and listener have disappeared.
          // Retarget only after bounded native proof prevents cached snapshot revival.
          stopManagedGatewayAndProve(
            runCommand,
            update.checkout,
            gatewayDeploymentBefore,
            proveGatewayStopped,
            sleep,
          );
        } catch (error) {
          try {
            resumeSuspension(
              update.checkout,
              gatewaySuspension.suspensionId,
              gatewayControlDeployment,
            );
          } catch (resumeError) {
            throw new AggregateError(
              [error, resumeError],
              "Gateway stop failed and the prepared maintenance suspension could not be resumed",
            );
          }
          throw error;
        }
      }
      if (actions.dependencyInstall && !controlDependenciesInstalled) {
        runCommand("pnpm", ["install", "--frozen-lockfile"], update.checkout);
      }
      if (actions.gatewayBuild && !controlBuildPrepared) {
        runBuildWithPreservedMacApp(runCommand, update.checkout, sleep);
      }
      assertExactBuild(update.checkout, update.afterSha);
      const restartStartedAt = Date.now();
      gatewayDeployment = gatewayDeploymentBefore
        ? repointGatewayDeployment(
            update.checkout,
            gatewayDeploymentBefore,
            replaceGatewayEntrypoint,
            inspectGatewayDeployment,
          )
        : null;
      restartGateway(
        runCommand,
        update.checkout,
        update.afterSha,
        restartStartedAt,
        gatewayDeployment,
        gatewayDeployment !== null,
      );
      gatewayLogAudit = verifyGatewayAfterRestart({
        runCommand,
        auditGatewayLogs,
        checkout: update.checkout,
        expectedSha: update.afterSha,
        deployment: gatewayDeployment,
        sinceMs: restartStartedAt,
        sleep,
      });
      gatewayRuntime = verifyGatewayRuntime(update.checkout, update.afterSha);
    } else {
      try {
        verifyGatewayProbe(runCommand, update.checkout, update.afterSha, gatewayControlDeployment);
        gatewayRuntime = verifyGatewayRuntime(update.checkout, update.afterSha);
      } catch {
        actions.gatewayRestart = true;
        actions.gatewaySelfHeal = true;
        const bootstrap =
          gatewayControlDeployment !== null && !isGatewayLoaded(gatewayControlDeployment);
        const restartStartedAt = restartGateway(
          runCommand,
          update.checkout,
          update.afterSha,
          Date.now(),
          gatewayControlDeployment,
          bootstrap,
        );
        gatewayLogAudit = verifyGatewayAfterRestart({
          runCommand,
          auditGatewayLogs,
          checkout: update.checkout,
          expectedSha: update.afterSha,
          deployment: gatewayControlDeployment,
          sinceMs: restartStartedAt,
          sleep,
        });
        gatewayRuntime = verifyGatewayRuntime(update.checkout, update.afterSha);
      }
    }
    if (actions.macAppRebuild) {
      const pendingState = {
        ...queuedMacState,
        attempts: Number(queuedMacState?.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
      };
      writeMaintenanceState(statePath, pendingState);
      try {
        // The exact-SHA JS build above already produced dist/control-ui. Letting
        // Mac packaging rebuild it can empty dist while the live app bundle is
        // there, defeating the staged-swap guarantee.
        runCommand(
          "env",
          [
            "SKIP_TSC=1",
            "SKIP_UI_BUILD=1",
            "bash",
            "scripts/restart-mac.sh",
            "--sign",
            "--wait",
            "--target-only",
          ],
          update.checkout,
        );
        const macTarget = verifyMacTarget(update.checkout);
        verifyGatewayProbe(
          runCommand,
          update.checkout,
          update.afterSha,
          gatewayDeployment ?? gatewayControlDeployment,
        );
        rmSync(statePath, { force: true });
        maintenanceState.macTarget = macTarget;
      } catch (error) {
        writeMaintenanceState(statePath, {
          ...pendingState,
          lastFailure: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    return {
      schemaVersion: 1,
      ok: true,
      ...update,
      buildBefore,
      buildChangedPaths,
      actions,
      ...(gatewayDeployment
        ? {
            gatewayDeployment: {
              changed: gatewayDeployment.changed,
              entrypoint: gatewayDeployment.entrypoint,
              label: gatewayDeployment.label,
              port: gatewayDeployment.port,
              ...(gatewayDeployment.previousEntrypoint
                ? { previousEntrypoint: gatewayDeployment.previousEntrypoint }
                : {}),
            },
          }
        : {}),
      ...(gatewayLogAudit ? { gatewayLogAudit } : {}),
      ...(gatewayRuntime ? { gatewayRuntime } : {}),
      ...(maintenanceState.macTarget ? { macTarget: maintenanceState.macTarget } : {}),
    };
  } finally {
    lock.release();
  }
}

function parseArgs(argv) {
  const options = { checkout: DEFAULT_CHECKOUT, remote: "origin" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--checkout") {
      options.checkout = argv[++index];
    } else if (arg === "--remote") {
      options.remote = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: update-main.mjs [--checkout PATH] [--remote NAME]");
      process.exit(0);
    } else {
      throw new UpdateInvariantError("invalid_argument", `unknown argument: ${arg}`);
    }
  }
  if (!options.checkout || !options.remote) {
    throw new UpdateInvariantError("invalid_argument", "option values must be non-empty");
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(maintainMain(parseArgs(argv))));
  } catch (error) {
    const code = error instanceof UpdateInvariantError ? error.code : "update_failed";
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } }));
    process.exitCode = 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
