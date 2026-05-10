#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./lib/bundled-plugin-build-entries.mjs";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
  resolveGitHead,
  writeBuildStamp as writeDistBuildStamp,
  writeRuntimePostBuildStamp as writeDistRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mjs";
import {
  discoverStaticExtensionAssets,
  listStaticExtensionAssetSources,
} from "./lib/static-extension-assets.mjs";
import {
  extensionRestartMetadataFiles,
  isBuildRelevantRunNodePath,
  isRestartRelevantRunNodePath,
  normalizeRunNodePath as normalizePath,
  runNodeConfigFiles,
  runNodeSourceRoots,
  runNodeWatchedPaths,
} from "./run-node-watch-paths.mjs";
import { listCoreRuntimePostBuildOutputs, runRuntimePostBuild } from "./runtime-postbuild.mjs";

export { isBuildRelevantRunNodePath, isRestartRelevantRunNodePath, runNodeWatchedPaths };

const buildScript = "scripts/tsdown-build.mjs";
const bundledPluginAssetsScript = "scripts/bundled-plugin-assets.mjs";
const compilerArgs = [buildScript, "--no-clean"];
const bundledPluginAssetBuildArgs = [bundledPluginAssetsScript, "--phase", "build"];

const runtimePostBuildWatchedPaths = [
  "scripts/copy-bundled-plugin-metadata.mjs",
  "scripts/copy-plugin-sdk-root-alias.mjs",
  "scripts/lib",
  "scripts/lib/local-build-metadata.mjs",
  "scripts/lib/local-build-metadata-paths.mjs",
  "scripts/npm-runner.mjs",
  "scripts/runtime-postbuild-stamp.mjs",
  "scripts/runtime-postbuild-shared.mjs",
  "scripts/runtime-postbuild.mjs",
  "scripts/stage-bundled-plugin-runtime.mjs",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/write-official-channel-catalog.mjs",
  "src/plugin-sdk/root-alias.cjs",
  BUNDLED_PLUGIN_ROOT_DIR,
];
const runtimePostBuildScriptPaths = new Set(
  runtimePostBuildWatchedPaths.filter((entry) => entry.startsWith("scripts/")),
);
const runtimePostBuildStaticAssetPaths = new Set(listStaticExtensionAssetSources());

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
const shouldIncludePrivateQaBundledOutputs = (env = process.env) =>
  env.OPENCLAW_BUILD_PRIVATE_QA === "1";

const shouldRequireBundledPluginRuntimeOutput = (pluginId, env = process.env) =>
  shouldIncludePrivateQaBundledOutputs(env) || !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(pluginId);

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
  return parseGitStatusPaths(output).some((repoPath) => {
    const normalizedPath = normalizePath(repoPath).replace(/^\.\/+/, "");
    return (
      isBuildRelevantRunNodePath(normalizedPath) ||
      isDirtyBundledPluginPackageEntryChangeWithoutBuiltOutputs(normalizedPath, deps)
    );
  });
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
  const pluginLocalPath = pluginRelativePath.split("/").slice(1).join("/");
  if (pluginLocalPath === "skills" || pluginLocalPath.startsWith("skills/")) {
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

const resolveRuntimePostBuildDistRoot = (deps) => deps.distRoot ?? path.join(deps.cwd, "dist");
const resolveRuntimePostBuildRuntimeRoot = (deps) => path.join(deps.cwd, "dist-runtime");

const collectRunNodeBundledPluginBuildEntries = (deps) => {
  if (!deps.fs.existsSync(path.join(deps.cwd, BUNDLED_PLUGIN_ROOT_DIR))) {
    return [];
  }
  return collectBundledPluginBuildEntries({ cwd: deps.cwd, env: deps.env });
};

const resolveBuiltBundledPluginRuntimeEntryPath = (distRoot, pluginId, sourceEntry) =>
  path.join(
    distRoot,
    "extensions",
    pluginId,
    sourceEntry.replace(/^\.\//, "").replace(/\.[^.]+$/u, ".js"),
  );

const listBundledPluginRuntimeEntryPaths = (pluginEntry, deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  return pluginEntry.sourceEntries
    .map((sourceEntry) =>
      resolveBuiltBundledPluginRuntimeEntryPath(distRoot, pluginEntry.id, sourceEntry),
    )
    .toSorted((left, right) => left.localeCompare(right));
};

const isDirtyBundledPluginPackageEntryChangeWithoutBuiltOutputs = (normalizedPath, deps) => {
  if (!normalizedPath.startsWith("extensions/") || !normalizedPath.endsWith("/package.json")) {
    return false;
  }
  const [, pluginId] = normalizedPath.split("/");
  if (!pluginId || !shouldRequireBundledPluginRuntimeOutput(pluginId, deps.env)) {
    return false;
  }
  const pluginEntry = collectRunNodeBundledPluginBuildEntries(deps).find(
    (entry) => entry.id === pluginId,
  );
  if (!pluginEntry) {
    return false;
  }
  return listBundledPluginRuntimeEntryPaths(pluginEntry, deps).some(
    (filePath) => !deps.fs.existsSync(filePath),
  );
};

const hasMissingBuiltBundledPluginRuntimeEntryOutput = (deps) => {
  return collectRunNodeBundledPluginBuildEntries(deps)
    .filter(({ id }) => shouldRequireBundledPluginRuntimeOutput(id, deps.env))
    .some((pluginEntry) => {
      const entryPaths = listBundledPluginRuntimeEntryPaths(pluginEntry, deps);
      return entryPaths.some((filePath) => !deps.fs.existsSync(filePath));
    });
};

const listBuiltBundledPluginEntries = (deps) => {
  return collectRunNodeBundledPluginBuildEntries(deps)
    .filter(({ id }) => shouldRequireBundledPluginRuntimeOutput(id, deps.env))
    .filter((pluginEntry) =>
      listBundledPluginRuntimeEntryPaths(pluginEntry, deps).some((filePath) =>
        deps.fs.existsSync(filePath),
      ),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
};

const listBuiltBundledPluginRuntimeOverlayDirs = (deps) => {
  const distExtensionsRoot = path.join(resolveRuntimePostBuildDistRoot(deps), "extensions");
  let entries = [];
  try {
    entries = deps.fs.readdirSync(distExtensionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
};

const listRequiredBundledPluginMetadataOutputs = (pluginEntries, deps) =>
  pluginEntries.flatMap(({ id, hasManifest, hasPackageJson }) => {
    const builtPluginDir = path.join(resolveRuntimePostBuildDistRoot(deps), "extensions", id);
    const requiredPaths = [];
    if (hasPackageJson) {
      requiredPaths.push(path.join(builtPluginDir, "package.json"));
    }
    if (hasManifest) {
      requiredPaths.push(path.join(builtPluginDir, "openclaw.plugin.json"));
    }
    return requiredPaths;
  });

const listRuntimeOverlaySourcePaths = (sourceDir, deps) => {
  const paths = [];
  const queue = [sourceDir];
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
      if (entry.name === "node_modules") {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        paths.push(entryPath);
      }
    }
  }
  return paths.toSorted((left, right) => left.localeCompare(right));
};

const listRequiredBundledPluginRuntimeOverlayOutputs = (deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  const runtimeRoot = resolveRuntimePostBuildRuntimeRoot(deps);
  const runtimePaths = [];
  for (const pluginId of listBuiltBundledPluginRuntimeOverlayDirs(deps)) {
    const distPluginDir = path.join(distRoot, "extensions", pluginId);
    const runtimePluginDir = path.join(runtimeRoot, "extensions", pluginId);
    for (const sourcePath of listRuntimeOverlaySourcePaths(distPluginDir, deps)) {
      runtimePaths.push(path.join(runtimePluginDir, path.relative(distPluginDir, sourcePath)));
    }
  }
  return [...new Set(runtimePaths)].toSorted((left, right) => left.localeCompare(right));
};

const listRequiredOpenClawExtensionAliasOutputs = (deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  const distExtensionsRoot = path.join(distRoot, "extensions");
  if (!deps.fs.existsSync(distExtensionsRoot)) {
    return [];
  }
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  let dirents = [];
  try {
    dirents = deps.fs.readdirSync(pluginSdkDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  return [
    path.join(aliasDir, "package.json"),
    ...dirents
      .filter((dirent) => dirent.isFile() && path.extname(dirent.name) === ".js")
      .map((dirent) => path.join(aliasDir, "plugin-sdk", dirent.name)),
  ].toSorted((left, right) => left.localeCompare(right));
};

const listRequiredStaticExtensionAssetOutputs = (deps) => {
  const distRoot = resolveRuntimePostBuildDistRoot(deps);
  return discoverStaticExtensionAssets({ rootDir: deps.cwd, fs: deps.fs })
    .filter((asset) => deps.fs.existsSync(path.join(deps.cwd, asset.src)))
    .map((asset) => path.join(distRoot, normalizePath(asset.dest).replace(/^dist\//u, "")))
    .toSorted((left, right) => left.localeCompare(right));
};

const listRequiredCoreRuntimePostBuildOutputs = (deps) =>
  listCoreRuntimePostBuildOutputs({ rootDir: deps.cwd, fs: deps.fs }).map((relativePath) =>
    path.join(deps.cwd, normalizePath(relativePath)),
  );

export const listRequiredRuntimePostBuildOutputs = (deps) => {
  const builtPluginEntries = listBuiltBundledPluginEntries(deps);
  return [
    ...listRequiredCoreRuntimePostBuildOutputs(deps),
    ...listRequiredOpenClawExtensionAliasOutputs(deps),
    ...listRequiredStaticExtensionAssetOutputs(deps),
    ...listRequiredBundledPluginMetadataOutputs(builtPluginEntries, deps),
    ...listRequiredBundledPluginRuntimeOverlayOutputs(deps),
  ];
};

const hasMissingRequiredRuntimePostBuildOutput = (deps) =>
  listRequiredRuntimePostBuildOutputs(deps).some(
    (filePath) => statMtime(filePath, deps.fs) == null,
  );

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
      if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
        return { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" };
      }
      return { shouldBuild: false, reason: "clean" };
    }
  }

  if (hasMissingBuiltBundledPluginRuntimeEntryOutput(deps)) {
    return { shouldBuild: true, reason: "missing_bundled_plugin_dist_entry" };
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
      if (hasMissingRequiredRuntimePostBuildOutput(deps)) {
        return { shouldSync: true, reason: "missing_runtime_postbuild_output" };
      }
      return { shouldSync: false, reason: "clean" };
    }
  }

  if (hasRuntimePostBuildInputMtimeChanged(stamp.mtime, deps)) {
    return { shouldSync: true, reason: "runtime_postbuild_input_mtime_newer" };
  }

  if (hasMissingRequiredRuntimePostBuildOutput(deps)) {
    return { shouldSync: true, reason: "missing_runtime_postbuild_output" };
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
  missing_bundled_plugin_dist_entry: "bundled plugin dist entry missing",
  source_mtime_newer: "source mtime newer than build stamp",
  missing_private_qa_dist: "private QA dist entry missing",
  clean: "clean",
};

const RUNTIME_POSTBUILD_REASON_LABELS = {
  force_runtime_postbuild: "forced by OPENCLAW_FORCE_RUNTIME_POSTBUILD",
  missing_runtime_postbuild_output: "required runtime postbuild output missing",
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
const RUN_NODE_CPU_PROF_DIR_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_DIR";
const RUN_NODE_FILTER_SYNC_IO_STDERR_ENV = "OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR";
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

const sanitizeCpuProfileNamePart = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "command";
};

const resolveRunNodeCpuProfileArgs = (deps) => {
  const profileDir = deps.env[RUN_NODE_CPU_PROF_DIR_ENV]?.trim();
  if (!profileDir) {
    return [];
  }

  const absoluteProfileDir = path.resolve(deps.cwd, profileDir);
  deps.fs.mkdirSync(absoluteProfileDir, { recursive: true });
  deps.env[RUN_NODE_CPU_PROF_DIR_ENV] = absoluteProfileDir;

  const commandName = sanitizeCpuProfileNamePart(deps.args[0]);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pid = Number.isInteger(deps.process.pid) && deps.process.pid > 0 ? deps.process.pid : "pid";
  const profileName = `openclaw-${commandName}-${pid}-${timestamp}.cpuprofile`;
  const profilePath = path.join(absoluteProfileDir, profileName);
  const relativeProfilePath = path.relative(deps.cwd, profilePath) || profilePath;
  logRunner(`Writing Node CPU profile to ${relativeProfilePath}.`, deps);
  return ["--cpu-prof", `--cpu-prof-dir=${absoluteProfileDir}`, `--cpu-prof-name=${profileName}`];
};

const resolveRunNodeDiagnosticArgs = (deps) => {
  const args = [...resolveRunNodeCpuProfileArgs(deps)];
  if (deps.env.OPENCLAW_TRACE_SYNC_IO === "1") {
    logRunner("Enabling Node --trace-sync-io for startup I/O diagnostics.", deps);
    args.push("--trace-sync-io");
  }
  return args;
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
      let settled = false;
      const settle = (res) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(res);
      };
      childProcess.on("error", (error) => {
        logRunner(`Spawn failed: ${error?.message ?? String(error)}`, deps);
        settle({ exitCode: 1, exitSignal: null, forwardedSignal });
      });
      childProcess.on("exit", (exitCode, exitSignal) => {
        settle({ exitCode, exitSignal, forwardedSignal });
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
  const diagnosticArgs = resolveRunNodeDiagnosticArgs(deps);
  const nodeProcess = deps.spawn(deps.execPath, [...diagnosticArgs, "openclaw.mjs", ...deps.args], {
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
  const stderrFilter =
    deps.env[RUN_NODE_FILTER_SYNC_IO_STDERR_ENV] === "1"
      ? createSyncIoTraceStderrFilter(deps)
      : null;
  childProcess.stdout?.on("data", (chunk) => {
    deps.stdout.write(chunk);
    deps.outputTee.write(chunk);
  });
  childProcess.stderr?.on("data", (chunk) => {
    if (stderrFilter) {
      stderrFilter.write(chunk);
    } else {
      deps.stderr.write(chunk);
    }
    deps.outputTee.write(chunk);
  });
  childProcess.stderr?.on("end", () => {
    stderrFilter?.flush();
  });
};

const createSyncIoTraceStderrFilter = (deps) => {
  let buffer = "";
  let inSyncIoTrace = false;

  const shouldSuppressLine = (line) => {
    const text = line.replace(/\r?\n$/, "");
    if (/^\(node:\d+\) WARNING: Detected use of sync API/.test(text)) {
      inSyncIoTrace = true;
      return true;
    }
    if (!inSyncIoTrace) {
      return false;
    }
    if (text.trim() === "") {
      inSyncIoTrace = false;
      return true;
    }
    if (/^\s+at\b/.test(text)) {
      return true;
    }
    inSyncIoTrace = false;
    return false;
  };

  const writeLine = (line) => {
    if (!shouldSuppressLine(line)) {
      deps.stderr.write(line);
    }
  };

  return {
    write(chunk) {
      buffer += String(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        writeLine(line);
      }
    },
    flush() {
      if (!buffer) {
        return;
      }
      writeLine(buffer);
      buffer = "";
    },
  };
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

const readBuildLockOwnerPid = (deps, lockDir) => {
  try {
    const raw = deps.fs.readFileSync(path.join(lockDir, "owner.json"), "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isBuildLockOwnerDead = (deps, pid) => {
  try {
    deps.process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
};

const removeStaleBuildLock = (deps, lockDir, staleMs) => {
  try {
    const ownerPid = readBuildLockOwnerPid(deps, lockDir);
    if (ownerPid !== null && isBuildLockOwnerDead(deps, ownerPid)) {
      deps.fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
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
    writeDistRuntimePostBuildStamp({
      cwd: deps.cwd,
      fs: deps.fs,
      spawnSync: deps.spawnSync,
    });
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

const shouldSkipWatchRuntimeSync = (deps, requirement) =>
  deps.env.OPENCLAW_WATCH_MODE === "1" &&
  requirement.reason === "missing_runtime_postbuild_stamp" &&
  hasDirtyRuntimePostBuildInputs(deps) !== true &&
  !hasMissingRequiredRuntimePostBuildOutput(deps);

const isGatewayClientCommand = (args) =>
  args[0] === "gateway" && (args[1] === "call" || args[1] === "status");

const shouldUseExistingDistForGatewayClient = (deps, buildRequirement) =>
  buildRequirement.reason === "dirty_watched_tree" &&
  isGatewayClientCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(deps.distEntry, deps.fs) != null;

const isQaParityReportCommand = (args) => args[0] === "qa" && args[1] === "parity-report";
const isQaCoverageReportCommand = (args) => args[0] === "qa" && args[1] === "coverage";

const shouldRunQaParityReportFromSource = (deps, buildRequirement) =>
  buildRequirement.reason === "missing_private_qa_dist" &&
  isQaParityReportCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(path.join(deps.cwd, "extensions", "qa-lab", "src", "cli.runtime.ts"), deps.fs) != null;

const shouldRunQaCoverageReportFromSource = (deps, buildRequirement) =>
  buildRequirement.reason === "missing_private_qa_dist" &&
  isQaCoverageReportCommand(deps.args) &&
  deps.env.OPENCLAW_FORCE_BUILD !== "1" &&
  statMtime(path.join(deps.cwd, "extensions", "qa-lab", "src", "cli.runtime.ts"), deps.fs) != null;

const runQaParityReportFromSource = async (deps) => {
  const sourceEntrypoint = path.join(deps.cwd, "scripts", "qa-parity-report.ts");
  const nodeProcess = deps.spawn(
    deps.execPath,
    ["--import", "tsx", sourceEntrypoint, ...deps.args.slice(2)],
    {
      cwd: deps.cwd,
      env: deps.env,
      stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
    },
  );
  pipeSpawnedOutput(nodeProcess, deps);
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  const interruptedExitCode = getInterruptedSpawnExitCode(res);
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return res.exitCode ?? 1;
};

const runQaCoverageReportFromSource = async (deps) => {
  const sourceEntrypoint = path.join(deps.cwd, "scripts", "qa-coverage-report.ts");
  const nodeProcess = deps.spawn(
    deps.execPath,
    ["--import", "tsx", sourceEntrypoint, ...deps.args.slice(2)],
    {
      cwd: deps.cwd,
      env: deps.env,
      stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
    },
  );
  pipeSpawnedOutput(nodeProcess, deps);
  const res = await waitForSpawnedProcess(nodeProcess, deps);
  const interruptedExitCode = getInterruptedSpawnExitCode(res);
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return res.exitCode ?? 1;
};

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
  deps.buildStampPath = path.join(deps.distRoot, BUILD_STAMP_FILE);
  deps.runtimePostBuildStampPath = path.join(deps.distRoot, RUNTIME_POSTBUILD_STAMP_FILE);
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
    let buildRequirement = resolveBuildRequirement(deps);
    const useExistingGatewayClientDist = shouldUseExistingDistForGatewayClient(
      deps,
      buildRequirement,
    );
    const useQaParityReportSource = shouldRunQaParityReportFromSource(deps, buildRequirement);
    const useQaCoverageReportSource = shouldRunQaCoverageReportFromSource(deps, buildRequirement);
    if (useExistingGatewayClientDist) {
      buildRequirement = { shouldBuild: false, reason: "gateway_client_existing_dist" };
    }
    if (useQaParityReportSource) {
      logRunner("Running QA parity report from source without rebuilding private QA dist.", deps);
      exitCode = await runQaParityReportFromSource(deps);
      return await closeRunNodeOutputTee(deps, exitCode);
    }
    if (useQaCoverageReportSource) {
      logRunner("Running QA coverage report from source without rebuilding private QA dist.", deps);
      exitCode = await runQaCoverageReportFromSource(deps);
      return await closeRunNodeOutputTee(deps, exitCode);
    }
    if (!buildRequirement.shouldBuild) {
      if (!useExistingGatewayClientDist) {
        const runtimePostBuildRequirement = resolveRuntimePostBuildRequirement(deps);
        if (
          runtimePostBuildRequirement.shouldSync &&
          !shouldSkipWatchRuntimeSync(deps, runtimePostBuildRequirement)
        ) {
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
      logRunner("Building bundled plugin assets.", deps);
      const buildCmd = deps.execPath;
      const assetBuild = deps.spawn(buildCmd, bundledPluginAssetBuildArgs, {
        cwd: deps.cwd,
        env: deps.env,
        stdio: deps.outputTee ? ["inherit", "pipe", "pipe"] : "inherit",
      });
      pipeSpawnedOutput(assetBuild, deps);
      const assetBuildRes = await waitForSpawnedProcess(assetBuild, deps);
      const assetBuildInterruptedExitCode = getInterruptedSpawnExitCode(assetBuildRes);
      if (assetBuildInterruptedExitCode !== null) {
        return assetBuildInterruptedExitCode;
      }
      if (assetBuildRes.exitCode !== 0 && assetBuildRes.exitCode !== null) {
        return assetBuildRes.exitCode;
      }

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
