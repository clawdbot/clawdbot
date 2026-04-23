#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveGitHead, writeBuildStamp as writeDistBuildStamp } from "./build-stamp.mjs";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { runRuntimePostBuild } from "./runtime-postbuild.mjs";

const buildScript = "scripts/tsdown-build.mjs";
const compilerArgs = [buildScript, "--no-clean"];

const runNodeSourceRoots = ["src", BUNDLED_PLUGIN_ROOT_DIR];
const runNodeConfigFiles = ["tsconfig.json", "package.json", "tsdown.config.ts"];
export const runNodeWatchedPaths = [...runNodeSourceRoots, ...runNodeConfigFiles];
const runtimePostBuildStampFile = ".runtime-postbuildstamp";
const runtimePostBuildWatchedPaths = [
  "scripts/copy-bundled-plugin-metadata.mjs",
  "scripts/copy-plugin-sdk-root-alias.mjs",
  "scripts/lib",
  "scripts/npm-runner.mjs",
  "scripts/runtime-postbuild-shared.mjs",
  "scripts/runtime-postbuild.mjs",
  "scripts/stage-bundled-plugin-runtime-deps.mjs",
  "scripts/stage-bundled-plugin-runtime.mjs",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/write-official-channel-catalog.mjs",
  "src/plugin-sdk/root-alias.cjs",
  BUNDLED_PLUGIN_ROOT_DIR,
];
const ignoredRunNodeRepoPaths = new Set([
  "src/canvas-host/a2ui/.bundle.hash",
  "src/canvas-host/a2ui/a2ui.bundle.js",
]);
const runtimePostBuildScriptPaths = new Set(
  runtimePostBuildWatchedPaths.filter((entry) => entry.startsWith("scripts/")),
);
const runtimePostBuildStaticAssetPaths = new Set([
  "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
  "extensions/diffs/assets/viewer-runtime.js",
]);
const extensionSourceFilePattern = /\.(?:[cm]?[jt]sx?)$/;
const extensionRestartMetadataFiles = new Set(["openclaw.plugin.json", "package.json"]);

const normalizePath = (filePath) => String(filePath ?? "").replaceAll("\\", "/");

const isIgnoredSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return (
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith("test-helpers.ts")
  );
};

const isBuildRelevantSourcePath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  return extensionSourceFilePattern.test(normalizedPath) && !isIgnoredSourcePath(normalizedPath);
};

const isRestartRelevantExtensionPath = (relativePath) => {
  const normalizedPath = normalizePath(relativePath);
  if (extensionRestartMetadataFiles.has(path.posix.basename(normalizedPath))) {
    return true;
  }
  return isBuildRelevantSourcePath(normalizedPath);
};

const isRelevantRunNodePath = (repoPath, isRelevantBundledPluginPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (ignoredRunNodeRepoPaths.has(normalizedPath)) {
    return false;
  }
  if (runNodeConfigFiles.includes(normalizedPath)) {
    return true;
  }
  if (normalizedPath.startsWith("src/")) {
    return !isIgnoredSourcePath(normalizedPath.slice("src/".length));
  }
  if (normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return isRelevantBundledPluginPath(normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length));
  }
  return false;
};

export const isBuildRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isBuildRelevantSourcePath);

export const isRestartRelevantRunNodePath = (repoPath) =>
  isRelevantRunNodePath(repoPath, isRestartRelevantExtensionPath);

const statMtime = (filePath, fsImpl = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const resolvePrivateQaRequiredDistEntries = (distRoot) => [
  path.join(distRoot, "plugin-sdk", "qa-lab.js"),
  path.join(distRoot, "plugin-sdk", "qa-runtime.js"),
];

const isExcludedSource = (filePath, sourceRoot, sourceRootName) => {
  const relativePath = normalizePath(path.relative(sourceRoot, filePath));
  if (relativePath.startsWith("..")) {
    return false;
  }
  return !isBuildRelevantRunNodePath(path.posix.join(sourceRootName, relativePath));
};

const findLatestMtime = (dirPath, shouldSkip, deps) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath, deps.fs);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const readGitStatus = (deps, paths = runNodeWatchedPaths) => {
  try {
    const result = deps.spawnSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal", "--", ...paths],
      {
        cwd: deps.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.status !== 0) {
      return null;
    }
    return result.stdout ?? "";
  } catch {
    return null;
  }
};

const parseGitStatusPaths = (output) =>
  output
    .split("\n")
    .flatMap((line) => line.slice(3).split(" -> "))
    .map((entry) => normalizePath(entry.trim()))
    .filter(Boolean);

const hasDirtySourceTree = (deps) => {
  const output = readGitStatus(deps);
  if (output === null) {
    return null;
  }
  return parseGitStatusPaths(output).some((repoPath) => isBuildRelevantRunNodePath(repoPath));
};

const isRuntimePostBuildRelevantPath = (repoPath) => {
  const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
  if (normalizedPath === "src/plugin-sdk/root-alias.cjs") {
    return true;
  }
  if (runtimePostBuildStaticAssetPaths.has(normalizedPath)) {
    return true;
  }
  if (
    normalizedPath.startsWith("scripts/") &&
    (runtimePostBuildScriptPaths.has(normalizedPath) || normalizedPath.startsWith("scripts/lib/"))
  ) {
    return true;
  }
  if (!normalizedPath.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
    return false;
  }
  const pluginRelativePath = normalizedPath.slice(BUNDLED_PLUGIN_PATH_PREFIX.length);
  if (pluginRelativePath.startsWith("skills/")) {
    return true;
  }
  return extensionRestartMetadataFiles.has(path.posix.basename(pluginRelativePath));
};

const hasDirtyRuntimePostBuildInputs = (deps) => {
  const output = readGitStatus(deps, runtimePostBuildWatchedPaths);
  if (output === null) {
    return null;
  }
  return parseGitStatusPaths(output).some((repoPath) => isRuntimePostBuildRelevantPath(repoPath));
};

const readJsonStamp = (filePath, deps) => {
  const mtime = statMtime(filePath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = deps.fs.readFileSync(filePath, "utf8").trim();
    if (!raw.startsWith("{")) {
      return { mtime, head: null };
    }
    const parsed = JSON.parse(raw);
    const head = typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
    return { mtime, head };
  } catch {
    return { mtime, head: null };
  }
};

const readBuildStamp = (deps) => readJsonStamp(deps.buildStampPath, deps);

const readRuntimePostBuildStamp = (deps) => {
  return readJsonStamp(deps.runtimePostBuildStampPath, deps);
};

const hasSourceMtimeChanged = (stampMtime, deps) => {
  let latestSourceMtime = null;
  for (const sourceRoot of deps.sourceRoots) {
    const sourceMtime = findLatestMtime(
      sourceRoot.path,
      (candidate) => isExcludedSource(candidate, sourceRoot.path, sourceRoot.name),
      deps,
    );
    if (sourceMtime != null && (latestSourceMtime == null || sourceMtime > latestSourceMtime)) {
      latestSourceMtime = sourceMtime;
    }
  }
  return latestSourceMtime != null && latestSourceMtime > stampMtime;
};

const findLatestRuntimePostBuildInputMtime = (absolutePath, relativePath, deps) => {
  const normalizedRelativePath = normalizePath(relativePath);
  const statsMtime = statMtime(absolutePath, deps.fs);
  if (statsMtime == null) {
    return null;
  }
  let stat;
  try {
    stat = deps.fs.statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) {
    return isRuntimePostBuildRelevantPath(normalizedRelativePath) ? statsMtime : null;
  }
  return findLatestMtime(
    absolutePath,
    (candidate) => {
      const candidateRelativePath = path.relative(deps.cwd, candidate);
      return !isRuntimePostBuildRelevantPath(candidateRelativePath);
    },
    deps,
  );
};

const hasRuntimePostBuildInputMtimeChanged = (stampMtime, deps) => {
  let latestInputMtime = null;
  for (const relativePath of runtimePostBuildWatchedPaths) {
    const absolutePath = path.join(deps.cwd, relativePath);
    const inputMtime = findLatestRuntimePostBuildInputMtime(absolutePath, relativePath, deps);
    if (inputMtime != null && (latestInputMtime == null || inputMtime > latestInputMtime)) {
      latestInputMtime = inputMtime;
    }
  }
  return latestInputMtime != null && latestInputMtime > stampMtime;
};

export const resolveBuildRequirement = (deps) => {
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    return { shouldBuild: true, reason: "force_build" };
  }
  if (
    deps.env.OPENCLAW_BUILD_PRIVATE_QA === "1" &&
    (deps.privateQaRequiredDistEntries ?? resolvePrivateQaRequiredDistEntries(deps.distRoot)).some(
      (entry) => statMtime(entry, deps.fs) == null,
    )
  ) {
    return { shouldBuild: true, reason: "missing_private_qa_dist" };
  }
  const stamp = readBuildStamp(deps);
  if (stamp.mtime == null) {
    return { shouldBuild: true, reason: "missing_build_stamp" };
  }
  if (statMtime(deps.distEntry, deps.fs) == null) {
    return { shouldBuild: true, reason: "missing_dist_entry" };
  }

  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > stamp.mtime) {
      return { shouldBuild: true, reason: "config_newer" };
    }
  }

  const currentHead = resolveGitHead(deps);
  if (currentHead && !stamp.head) {
    return { shouldBuild: true, reason: "build_stamp_missing_head" };
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return { shouldBuild: true, reason: "git_head_changed" };
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree(deps);
    if (dirty === true) {
      return { shouldBuild: true, reason: "dirty_watched_tree" };
    }
    if (dirty === false) {
      return { shouldBuild: false, reason: "clean" };
    }
  }

  if (hasSourceMtimeChanged(stamp.mtime, deps)) {
    return { shouldBuild: true, reason: "source_mtime_newer" };
  }
  return { shouldBuild: false, reason: "clean" };
};

export const resolveRuntimePostBuildRequirement = (deps) => {
  if (deps.env.OPENCLAW_FORCE_RUNTIME_POSTBUILD === "1") {
    return { shouldSync: true, reason: "force_runtime_postbuild" };
  }

  const stamp = readRuntimePostBuildStamp(deps);
  if (stamp.mtime == null) {
    return { shouldSync: true, reason: "missing_runtime_postbuild_stamp" };
  }

  const buildStamp = readBuildStamp(deps);
  if (buildStamp.mtime == null) {
    return { shouldSync: true, reason: "missing_build_stamp" };
  }
  if (buildStamp.mtime > stamp.mtime) {
    return { shouldSync: true, reason: "build_stamp_newer" };
  }

  const currentHead = resolveGitHead(deps);
  if (currentHead && !stamp.head) {
    return { shouldSync: true, reason: "runtime_postbuild_stamp_missing_head" };
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return { shouldSync: true, reason: "git_head_changed" };
  }
  if (currentHead) {
    const dirty = hasDirtyRuntimePostBuildInputs(deps);
    if (dirty === true) {
      return { shouldSync: true, reason: "dirty_runtime_postbuild_inputs" };
    }
    if (dirty === false) {
      return { shouldSync: false, reason: "clean" };
    }
  }

  if (hasRuntimePostBuildInputMtimeChanged(stamp.mtime, deps)) {
    return { shouldSync: true, reason: "runtime_postbuild_input_mtime_newer" };
  }

  return { shouldSync: false, reason: "clean" };
};

const BUILD_REASON_LABELS = {
  force_build: "forced by OPENCLAW_FORCE_BUILD",
  missing_build_stamp: "build stamp missing",
  missing_dist_entry: "dist entry missing",
  config_newer: "config newer than build stamp",
  build_stamp_missing_head: "build stamp missing git head",
  git_head_changed: "git head changed",
  dirty_watched_tree: "dirty watched source tree",
  source_mtime_newer: "source mtime newer than build stamp",
  missing_private_qa_dist: "private QA dist entry missing",
  clean: "clean",
};

const RUNTIME_POSTBUILD_REASON_LABELS = {
  force_runtime_postbuild: "forced by OPENCLAW_FORCE_RUNTIME_POSTBUILD",
  missing_runtime_postbuild_stamp: "runtime postbuild stamp missing",
  missing_build_stamp: "build stamp missing",
  build_stamp_newer: "build stamp newer than runtime postbuild stamp",
  runtime_postbuild_stamp_missing_head: "runtime postbuild stamp missing git head",
  git_head_changed: "git head changed",
  dirty_runtime_postbuild_inputs: "dirty runtime postbuild inputs",
  runtime_postbuild_input_mtime_newer: "runtime postbuild input mtime newer than stamp",
  clean: "clean",
};

const formatBuildReason = (reason) => BUILD_REASON_LABELS[reason] ?? reason;
const formatRuntimePostBuildReason = (reason) => RUNTIME_POSTBUILD_REASON_LABELS[reason] ?? reason;

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

const isSignalKey = (signal) => Object.hasOwn(SIGNAL_EXIT_CODES, signal);

const getSignalExitCode = (signal) => (isSignalKey(signal) ? SIGNAL_EXIT_CODES[signal] : 1);

const RUN_NODE_OUTPUT_LOG_ENV = "OPENCLAW_RUN_NODE_OUTPUT_LOG";
const RUN_NODE_BUILD_LOCK_TIMEOUT_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_TIMEOUT_MS";
const RUN_NODE_BUILD_LOCK_POLL_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS";
const RUN_NODE_BUILD_LOCK_STALE_ENV = "OPENCLAW_RUN_NODE_BUILD_LOCK_STALE_MS";
const DEFAULT_BUILD_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BUILD_LOCK_POLL_MS = 100;
const DEFAULT_BUILD_LOCK_STALE_MS = 10 * 60 * 1000;

const parsePositiveIntegerEnv = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveRunNodeOutputLogPath = (deps) => {
  const outputLog = deps.env[RUN_NODE_OUTPUT_LOG_ENV]?.trim();
  if (!outputLog) {
    return null;
  }
  return path.resolve(deps.cwd, outputLog);
};

const createRunNodeOutputTee = (deps) => {
  const outputLogPath = resolveRunNodeOutputLogPath(deps);
  if (!outputLogPath) {
    return null;
  }
  deps.fs.mkdirSync(path.dirname(outputLogPath), { recursive: true });
  const stream = deps.fs.createWriteStream(outputLogPath, {
    flags: "a",
    mode: 0o600,
  });
  let streamError = null;
  stream.on("error", (error) => {
    streamError = error;
  });
  deps.env[RUN_NODE_OUTPUT_LOG_ENV] = outputLogPath;
  return {
    outputLogPath,
    write(chunk) {
      if (!streamError) {
        stream.write(chunk);
      }
    },
    async close() {
      if (streamError) {
        throw streamError;
      }
      await new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
      });
      if (streamError) {
        throw streamError;
      }
    },
  };
};

const logRunner = (message, deps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  const line = `[openclaw] ${message}\n`;
  deps.stderr.write(line);
  deps.outputTee?.write(line);
};

const waitForSpawnedProcess = async (childProcess, deps) => {
  let forwardedSignal = null;
  let onSigInt;
  let onSigTerm;

  const cleanupSignals = () => {
    if (onSigInt) {
      deps.process.off("SIGINT", onSigInt);
    }
    if (onSigTerm) {
      deps.process.off("SIGTERM", onSigTerm);
    }
  };

  const forwardSignal = (signal) => {
    if (forwardedSignal) {
      return;
    }
    forwardedSignal = signal;
    try {
      childProcess.kill?.(signal);
    } catch {
      // Best-effort only. Exit handling still happens via the child "exit" event.
    }
  };

  onSigInt = () => {
    forwardSignal("SIGINT");
  };
  onSigTerm = () => {
    forwardSignal("SIGTERM");
  };

  deps.process.on("SIGINT", onSigInt);
  deps.process.on("SIGTERM", onSigTerm);

  try {
    return await new Promise((resolve) => {
      childProcess.on("exit", (exitCode, exitSignal) => {
        resolve({ exitCode, exitSignal, forwardedSignal });
      });
    });
  } finally {
    cleanupSignals();
  }
};

const getInterruptedSpawnExitCode = (res) => {
  if (res.exitSignal) {
    return getSignalExitCode(res.exitSignal);
  }
  if (res.forwardedSignal) {
    return getSignalExitCode(res.forwardedSignal);
  }
  return null;
};

const runOpenClaw = async (deps) => {
  const nodeProcess = deps.spawn(deps.execPath, ["openclaw.mjs", ...deps.args], {
    cwd: deps.cwd,
    env: deps.env,
    stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  pipeSpawnedOutput(nodeProcess, deps);
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  const interruptedExitCode = getInterruptedSpawnExitCode(res);
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return res.exitCode ?? 1;
};

const pipeSpawnedOutput = (childProcess, deps) => {
  if (!deps.outputTee) {
    return;
  }
  childProcess.stdout?.on("data", (chunk) => {
    deps.stdout.write(chunk);
    deps.outputTee.write(chunk);
  });
  childProcess.stderr?.on("data", (chunk) => {
    deps.stderr.write(chunk);
    deps.outputTee.write(chunk);
  });
};

const closeRunNodeOutputTee = async (deps, exitCode) => {
  if (!deps.outputTee) {
    return exitCode;
  }
  try {
    await deps.outputTee.close();
  } catch (error) {
    deps.stderr.write(
      `[openclaw] Failed to write output log: ${error?.message ?? "unknown error"}\n`,
    );
    return exitCode === 0 ? 1 : exitCode;
  }
  return exitCode;
};

const removeStaleBuildLock = (deps, lockDir, staleMs) => {
  try {
    const stats = deps.fs.statSync(lockDir);
    if (Date.now() - stats.mtimeMs < staleMs) {
      return false;
    }
    deps.fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

export const acquireRunNodeBuildLock = async (deps) => {
  const lockRoot = path.join(deps.cwd, ".artifacts");
  const lockDir = path.join(lockRoot, "run-node-build.lock");
  const timeoutMs = parsePositiveIntegerEnv(
    deps.env,
    RUN_NODE_BUILD_LOCK_TIMEOUT_ENV,
    DEFAULT_BUILD_LOCK_TIMEOUT_MS,
  );
  const pollMs = parsePositiveIntegerEnv(
    deps.env,
    RUN_NODE_BUILD_LOCK_POLL_ENV,
    DEFAULT_BUILD_LOCK_POLL_MS,
  );
  const staleMs = parsePositiveIntegerEnv(
    deps.env,
    RUN_NODE_BUILD_LOCK_STALE_ENV,
    DEFAULT_BUILD_LOCK_STALE_MS,
  );
  const startedAt = Date.now();
  let loggedWait = false;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      deps.fs.mkdirSync(lockRoot, { recursive: true });
      deps.fs.mkdirSync(lockDir);
      try {
        deps.fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify(
            {
              pid: deps.process.pid,
              startedAt: new Date().toISOString(),
              args: deps.args,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch {
        // Owner metadata is diagnostic only; the directory itself is the lock.
      }
      let released = false;
      const removeLockDir = () => {
        if (released) {
          return;
        }
        released = true;
        try {
          deps.fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; a follow-up waiter will fall back to staleness
          // detection if the directory is still present.
        }
      };
      const onSignal = () => removeLockDir();
      const onExit = () => removeLockDir();
      deps.process.on("SIGINT", onSignal);
      deps.process.on("SIGTERM", onSignal);
      deps.process.on("exit", onExit);
      return () => {
        deps.process.off("SIGINT", onSignal);
        deps.process.off("SIGTERM", onSignal);
        deps.process.off("exit", onExit);
        removeLockDir();
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (removeStaleBuildLock(deps, lockDir, staleMs)) {
        continue;
      }
      if (!loggedWait) {
        logRunner("Waiting for TypeScript/runtime artifact lock.", deps);
        loggedWait = true;
      }
      await sleep(pollMs);
    }
  }

  throw new Error(`timed out waiting for ${path.relative(deps.cwd, lockDir)}`);
};

const withRunNodeBuildLock = async (deps, callback) => {
  const release = await acquireRunNodeBuildLock(deps);
  try {
    return await callback();
  } finally {
    release();
  }
};

const syncRuntimeArtifacts = async (deps) => {
  try {
    await deps.runRuntimePostBuild({ cwd: deps.cwd, env: deps.env });
  } catch (error) {
    logRunner(
      `Failed to write runtime build artifacts: ${error?.message ?? "unknown error"}`,
      deps,
    );
    return false;
  }
  return true;
};

const writeRuntimePostBuildStamp = (deps) => {
  try {
    deps.fs.mkdirSync(path.dirname(deps.runtimePostBuildStampPath), { recursive: true });
    const head = resolveGitHead(deps);
    deps.fs.writeFileSync(
      deps.runtimePostBuildStampPath,
      `${JSON.stringify(
        {
          syncedAt: Date.now(),
          ...(head ? { head } : {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    logRunner(
      `Failed to write runtime postbuild stamp: ${error?.message ?? "unknown error"}`,
      deps,
    );
  }
};

const syncRuntimeArtifactsAndStamp = async (deps) => {
  const synced = await syncRuntimeArtifacts(deps);
  if (synced) {
    writeRuntimePostBuildStamp(deps);
  }
  return synced;
};

const writeBuildStamp = (deps) => {
  try {
    writeDistBuildStamp({
      cwd: deps.cwd,
      fs: deps.fs,
      spawnSync: deps.spawnSync,
    });
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`, deps);
  }
};

const shouldSkipCleanWatchRuntimeSync = (deps) => deps.env.OPENCLAW_WATCH_MODE === "1";

export async function runNodeMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    spawnSync: params.spawnSync ?? spawnSync,
    fs: params.fs ?? fs,
    stderr: params.stderr ?? process.stderr,
    stdout: params.stdout ?? process.stdout,
    process: params.process ?? process,
    execPath: params.execPath ?? process.execPath,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    runRuntimePostBuild: params.runRuntimePostBuild ?? runRuntimePostBuild,
  };

  deps.distRoot = path.join(deps.cwd, "dist");
  deps.distEntry = path.join(deps.distRoot, "/entry.js");
  deps.buildStampPath = path.join(deps.distRoot, ".buildstamp");
  deps.runtimePostBuildStampPath = path.join(deps.distRoot, runtimePostBuildStampFile);
  deps.sourceRoots = runNodeSourceRoots.map((sourceRoot) => ({
    name: sourceRoot,
    path: path.join(deps.cwd, sourceRoot),
  }));
  deps.configFiles = runNodeConfigFiles.map((filePath) => path.join(deps.cwd, filePath));
  deps.privateQaRequiredDistEntries = resolvePrivateQaRequiredDistEntries(deps.distRoot);
  if (deps.args[0] === "qa") {
    deps.env.OPENCLAW_BUILD_PRIVATE_QA = "1";
    deps.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
  }
  deps.outputTee = createRunNodeOutputTee(deps);

  try {
    let exitCode = 1;
    const buildRequirement = resolveBuildRequirement(deps);
    if (!buildRequirement.shouldBuild) {
      if (!shouldSkipCleanWatchRuntimeSync(deps)) {
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        if (runtimePostBuildRequirement.shouldSync) {
          const synced = await withRunNodeBuildLock(deps, async () => {
            const lockedRuntimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
            if (!lockedRuntimePostBuildRequirement.shouldSync) {
              return true;
            }
            logRunner(
              `Syncing runtime artifacts (${lockedRuntimePostBuildRequirement.reason} - ${formatRuntimePostBuildReason(lockedRuntimePostBuildRequirement.reason)}).`,
              deps,
            );
            return await syncRuntimeArtifactsAndStamp(deps);
          });
          if (!synced) {
            return await closeRunNodeOutputTee(deps, 1);
          }
        }
      }
      exitCode = await runOpenClaw(deps);
      return await closeRunNodeOutputTee(deps, exitCode);
    }

    const buildExitCode = await withRunNodeBuildLock(deps, async () => {
      const lockedBuildRequirement = resolveBuildRequirement(deps);
      if (!lockedBuildRequirement.shouldBuild) {
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        if (!runtimePostBuildRequirement.shouldSync) {
          return 0;
        }
        logRunner(
          `Syncing runtime artifacts (${runtimePostBuildRequirement.reason} - ${formatRuntimePostBuildReason(runtimePostBuildRequirement.reason)}).`,
          deps,
        );
        return (await syncRuntimeArtifactsAndStamp(deps)) ? 0 : 1;
      }

      logRunner(
        `Building TypeScript (dist is stale: ${lockedBuildRequirement.reason} - ${formatBuildReason(lockedBuildRequirement.reason)}).`,
        deps,
      );
      const buildCmd = deps.execPath;
      const buildArgs = compilerArgs;
      const build = deps.spawn(buildCmd, buildArgs, {
        cwd: deps.cwd,
        env: deps.env,
        stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
      });
      pipeSpawnedOutput(build, deps);

      const buildRes = await waitForSpawnedProcess(build, deps);
      const interruptedExitCode = getInterruptedSpawnExitCode(buildRes);
      if (interruptedExitCode !== null) {
        return interruptedExitCode;
      }
      if (buildRes.exitCode !== 0 && buildRes.exitCode !== null) {
        return buildRes.exitCode;
      }
      if (!(await syncRuntimeArtifacts(deps))) {
        return 1;
      }
      writeBuildStamp(deps);
      writeRuntimePostBuildStamp(deps);
      return 0;
    });
    if (buildExitCode !== 0) {
      return await closeRunNodeOutputTee(deps, buildExitCode);
    }
    exitCode = await runOpenClaw(deps);
    return await closeRunNodeOutputTee(deps, exitCode);
  } catch (error) {
    await closeRunNodeOutputTee(deps, 1);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
