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
const GATEWAY_READINESS_ATTEMPTS = 3;
const GATEWAY_READINESS_RETRY_DELAY_MS = 5_000;
const GATEWAY_SUSPEND_TIMEOUT_MS = 10_000;
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
  const portFlag = Array.isArray(programArguments) ? programArguments.indexOf("--port") : -1;
  const port = Number(portFlag >= 0 ? programArguments[portFlag + 1] : Number.NaN);
  if (
    typeof label !== "string" ||
    !Array.isArray(programArguments) ||
    !programArguments.includes(path.join(checkout, "dist/index.js")) ||
    !programArguments.includes("gateway") ||
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
      : path.join(home, ".openclaw/openclaw.json");
  return { configPath, label, port };
}

function runBuiltGatewayCall(checkout, method, params) {
  const { configPath, port } = readManagedGatewayLaunchAgent(checkout);
  const overlayPath = path.join(
    path.dirname(configPath),
    `.openclaw-live-updater-config-${randomUUID()}.json`,
  );
  writeFileSync(
    overlayPath,
    `${JSON.stringify({
      $include: `./${path.basename(configPath)}`,
      gateway: { mode: "local", port },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: overlayPath,
    OPENCLAW_GATEWAY_PORT: String(port),
  };
  delete env.OPENCLAW_GATEWAY_URL;
  delete env.OPENCLAW_GATEWAY_TOKEN;
  delete env.OPENCLAW_GATEWAY_PASSWORD;
  try {
    return execFileSync(
      process.execPath,
      [
        "dist/index.js",
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
        "--timeout",
        String(GATEWAY_SUSPEND_TIMEOUT_MS),
      ],
      {
        cwd: checkout,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
  } finally {
    rmSync(overlayPath, { force: true });
  }
}

export function prepareGatewaySuspension(checkout, callGateway = runBuiltGatewayCall) {
  const requestId = `openclaw-live-updater-${randomUUID()}`;
  let result;
  try {
    result = JSON.parse(callGateway(checkout, "gateway.suspend.prepare", { requestId }));
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

function defaultResumeGatewaySuspension(checkout, suspensionId) {
  runBuiltGatewayCall(checkout, "gateway.suspend.resume", { suspensionId });
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

function restartGateway(runCommand, checkout, expectedSha) {
  assertExactBuild(checkout, expectedSha);
  const startedAtMs = Date.now();
  runCommand("pnpm", ["openclaw", "gateway", "restart"], checkout);
  return startedAtMs;
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

function defaultSleep(ms) {
  execFileSync("sleep", [String(ms / 1_000)]);
}

export function verifyGatewayReadiness(runCommand, checkout, expectedSha, sleep = defaultSleep) {
  let lastError;
  for (let attempt = 1; attempt <= GATEWAY_READINESS_ATTEMPTS; attempt += 1) {
    try {
      verifyGateway(runCommand, checkout, expectedSha);
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

export function parseGatewayLogAudit(output, sinceMs) {
  const entries = output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const raw = JSON.parse(line);
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
          },
        ];
      } catch {
        return [];
      }
    });
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

function defaultAuditGatewayLogs(checkout, sinceMs) {
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
  const audit = parseGatewayLogAudit(output, sinceMs);
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
  sinceMs,
  sleep,
}) {
  let verificationError;
  try {
    verifyGatewayReadiness(runCommand, checkout, expectedSha, sleep);
  } catch (error) {
    verificationError = error;
  }
  const audit = auditGatewayLogs(checkout, sinceMs);
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
    const prepareSuspension = dependencies.prepareGatewaySuspension ?? prepareGatewaySuspension;
    const resumeSuspension = dependencies.resumeGatewaySuspension ?? defaultResumeGatewaySuspension;
    const proveGatewayStopped = dependencies.proveGatewayStopped ?? defaultProveGatewayStopped;
    const verifyMacTarget = dependencies.verifyMacTarget ?? defaultVerifyMacTarget;
    const auditGatewayLogs = dependencies.auditGatewayLogs ?? defaultAuditGatewayLogs;
    const sleep = dependencies.sleep ?? defaultSleep;
    let gatewayLogAudit = null;
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

    if (actions.gatewayBuild || actions.dependencyInstall) {
      let gatewaySuspension;
      try {
        gatewaySuspension = prepareSuspension(update.checkout);
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
        // Use the existing built CLI directly. Source launchers may auto-build a
        // stale dist before dispatching `gateway stop`, recreating the live-import race.
        try {
          runCommand(process.execPath, ["dist/index.js", "gateway", "stop"], update.checkout);
        } catch (error) {
          try {
            resumeSuspension(update.checkout, gatewaySuspension.suspensionId);
          } catch (resumeError) {
            throw new AggregateError(
              [error, resumeError],
              "Gateway stop failed and the prepared maintenance suspension could not be resumed",
            );
          }
          throw error;
        }
      }
      if (actions.dependencyInstall) {
        runCommand("pnpm", ["install", "--frozen-lockfile"], update.checkout);
      }
      if (actions.gatewayBuild) {
        runBuildWithPreservedMacApp(runCommand, update.checkout, sleep);
      }
      assertExactBuild(update.checkout, update.afterSha);
      const restartStartedAt = restartGateway(runCommand, update.checkout, update.afterSha);
      gatewayLogAudit = verifyAndAuditGateway({
        runCommand,
        auditGatewayLogs,
        checkout: update.checkout,
        expectedSha: update.afterSha,
        sinceMs: restartStartedAt,
        sleep,
      });
    } else {
      try {
        verifyGateway(runCommand, update.checkout, update.afterSha);
      } catch {
        actions.gatewayRestart = true;
        actions.gatewaySelfHeal = true;
        const restartStartedAt = restartGateway(runCommand, update.checkout, update.afterSha);
        gatewayLogAudit = verifyAndAuditGateway({
          runCommand,
          auditGatewayLogs,
          checkout: update.checkout,
          expectedSha: update.afterSha,
          sinceMs: restartStartedAt,
          sleep,
        });
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
      ...(gatewayLogAudit ? { gatewayLogAudit } : {}),
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
