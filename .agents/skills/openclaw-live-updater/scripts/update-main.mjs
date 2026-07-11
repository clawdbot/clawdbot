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

export function classifyActions(
  changedPaths,
  { buildProvenanceKnown, buildRequired, nodeModulesPresent },
) {
  const runMacos = changedPaths.length > 0 && detectChangedScope(changedPaths).runMacos;
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
  return {
    dependencyInstall:
      !nodeModulesPresent || (buildRequired && (dependencyInputsChanged || !buildProvenanceKnown)),
    gatewayBuild: buildRequired,
    gatewayProbe: true,
    gatewayRestart: buildRequired,
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

function restartGateway(runCommand, checkout, expectedSha) {
  assertExactBuild(checkout, expectedSha);
  runCommand("pnpm", ["openclaw", "gateway", "restart"], checkout);
}

function verifyGateway(runCommand, checkout, expectedSha) {
  assertExactBuild(checkout, expectedSha);
  runCommand(
    "pnpm",
    ["openclaw", "gateway", "status", "--deep", "--require-rpc", "--json"],
    checkout,
  );
  runCommand("pnpm", ["openclaw", "health", "--verbose", "--json"], checkout);
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
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    const verifyMacTarget = dependencies.verifyMacTarget ?? defaultVerifyMacTarget;
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

    if (actions.dependencyInstall) {
      runCommand("pnpm", ["install", "--frozen-lockfile"], update.checkout);
    }
    if (actions.gatewayBuild) {
      runCommand("pnpm", ["build"], update.checkout);
      assertExactBuild(update.checkout, update.afterSha);
      restartGateway(runCommand, update.checkout, update.afterSha);
      verifyGateway(runCommand, update.checkout, update.afterSha);
    } else {
      try {
        verifyGateway(runCommand, update.checkout, update.afterSha);
      } catch {
        actions.gatewayRestart = true;
        actions.gatewaySelfHeal = true;
        restartGateway(runCommand, update.checkout, update.afterSha);
        verifyGateway(runCommand, update.checkout, update.afterSha);
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
        runCommand(
          "bash",
          ["scripts/restart-mac.sh", "--sign", "--wait", "--target-only"],
          update.checkout,
        );
        const macTarget = verifyMacTarget(update.checkout);
        verifyGateway(runCommand, update.checkout, update.afterSha);
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
