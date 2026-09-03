#!/usr/bin/env node

// Runs the tsdown build with output cleanup, stale chunk pruning, and bounded
// child-process diagnostics.
import {
  spawn,
  spawnSync,
  type StdioOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { decodeMountInfoPath } from "../packages/normalization-core/src/mountinfo-path.ts";
import { BUNDLED_PLUGIN_BUILD_ENV_NAMES } from "./lib/bundled-plugin-build-entries.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import { CLAUDE_AGENT_SDK_ASSET_DIR } from "./lib/claude-agent-sdk-assets.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { toErrorObject } from "./lib/error-format.mts";
import {
  inspectManagedProcessGroup,
  signalExitCode,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "./lib/tsdown-config-groups.mts";
import {
  TSDOWN_PACKAGE_OUTPUT_ROOTS,
  tsdownPackageOutputRoot,
} from "./lib/tsdown-output-roots.mts";
import { resolvePnpmRunner } from "./pnpm-runner.mts";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const INEFFECTIVE_DYNAMIC_IMPORT_MARKER = "[INEFFECTIVE_DYNAMIC_IMPORT]";
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const DEPENDENCY_PATH_MARKERS = ["node_modules/", "openclaw-pnpm-node-modules/"];
const HASHED_ROOT_JS_RE = /^(?<base>.+)-[A-Za-z0-9_-]+\.js$/u;
const DEFAULT_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TSDOWN_MAX_OLD_SPACE_MB = 12288;
const DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB = 8192;
export const TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB";
const DOCKER_TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB";
const TSDOWN_CGROUP_MEMORY_HEADROOM_MB = 768;
const DEFAULT_CGROUP_V2_MOUNT_PATH = "/sys/fs/cgroup";
const DEFAULT_CGROUP_V1_MEMORY_MOUNT_PATH = "/sys/fs/cgroup/memory";
const PROC_SELF_CGROUP_PATH = "/proc/self/cgroup";
const PROC_SELF_LIMITS_PATH = "/proc/self/limits";
const PROC_SELF_MOUNTINFO_PATH = "/proc/self/mountinfo";
const PROC_SELF_STATUS_PATH = "/proc/self/status";
const SERIALIZED_MAIN_CONFIG_GROUPS = [
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
];
// The v2 high limit throttles reclaim, so a heap sized above it can stall the build instead of
// OOM-ing. Cgroup v1's soft limit is only advisory and must not reject an otherwise viable build.
const CGROUP_V2_MEMORY_LIMIT_FILES = ["memory.max", "memory.high"];
const CGROUP_V1_MEMORY_LIMIT_FILES = ["memory.limit_in_bytes"];
const PROC_MEMINFO_PATH = "/proc/meminfo";
const tsdownStdio = () => ["ignore", "pipe", "pipe"] satisfies ["ignore", "pipe", "pipe"];
// Build descendants get a short cleanup window; a timed-out build must not hold CI for seconds.
const TERMINATION_GRACE_MS = 250;
const POST_FORCE_KILL_WAIT_MS = 250;
const ROOT_TSDOWN_OUTPUT_ROOTS = ["dist", "dist-runtime"];
const PRESERVED_TSDOWN_OUTPUT_FILES = ["dist/cli-startup-metadata.json"];
const PRESERVE_CLI_STARTUP_METADATA_ENV = "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA";
const GENERATED_SOURCE_DECLARATION_PATHSPEC = ":(glob)extensions/**/*.d.ts";
export const TSDOWN_DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const SOURCE_DECLARATION_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";

const TSDOWN_SOURCE_EXTENSIONS = [
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".json5",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
];

export const TSDOWN_DECLARATION_TOOL_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/tsdown-build.mts",
  "scripts/build-all.mts",
  "scripts/lib/build-artifact-cache.mts",
  "scripts/lib/dist-artifact-ownership.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/repo-root.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/lib/tsdown-config-groups.mts",
  "scripts/lib/tsdown-output-roots.mts",
];
export const TSDOWN_PACKAGES_CACHE_INPUT = {
  path: "packages",
  extensions: TSDOWN_SOURCE_EXTENSIONS,
  excludeDirectories: ["dist", "node_modules"],
};
export const TSDOWN_UNIFIED_CACHE_ENV = [
  "OPENCLAW_BUILD_PRIVATE_QA",
  ...BUNDLED_PLUGIN_BUILD_ENV_NAMES,
];

type OutputRootParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  pathImpl?: Pick<typeof path, "dirname" | "parse" | "resolve">;
  roots?: string[];
};

export type MemoryLimitParams = {
  availableMemoryBytes?: number;
  cgroupMemoryLimitBytes?: number;
  cgroupMemoryLimitPaths?: string[];
  constrainedMemoryBytes?: number;
  env?: NodeJS.ProcessEnv;
  fs?: { readFileSync(filePath: string, encoding: "utf8"): string };
  physicalMemoryBytes?: number;
  platform?: string;
  processResidentMemoryBytes?: number;
  procMeminfoPath?: string;
  procMemTotalBytes?: number;
};

type CgroupMount = { mountPoint: string; observed: boolean; root: string };

type ResolvedMemoryLimitParams = MemoryLimitParams & { resolvedMaxOldSpaceMb?: number };

type TsdownBuildParams = ResolvedMemoryLimitParams & {
  args?: string[];
  comSpec?: string;
  nodeExecPath?: string;
  npmExecPath?: string;
};

type TsdownBuildResult = ReturnType<ReturnType<typeof createTsdownOutputScanner>["finish"]> & {
  error: Error | null;
  signal: string | null;
  status: number | null;
  timedOut: boolean;
};

type TsdownBuildInvocation = {
  command: string;
  args: string[];
  options: {
    stdio: string[];
    shell: boolean;
    windowsVerbatimArguments?: boolean;
    env: NodeJS.ProcessEnv;
  };
};

function removeDistPluginNodeModulesSymlinks(rootDir: string) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

export function pruneStaleRuntimeSymlinks(params: Pick<OutputRootParams, "cwd" | "fs"> = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const distRoot = path.join(cwd, "dist");
  const distRuntimeRoot = path.join(cwd, "dist-runtime");
  assertRealOutputRoot(distRoot, { fs: fsImpl });
  assertRealOutputRoot(distRuntimeRoot, { fs: fsImpl });
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(distRoot);
  removeDistPluginNodeModulesSymlinks(distRuntimeRoot);
}

/**
 * Removes build output roots while preserving explicitly protected artifacts.
 */
function assertTsdownCleanOutputRoots(params: OutputRootParams = {}) {
  const pathImpl = params.pathImpl ?? path;
  const cwd = pathImpl.resolve(params.cwd ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const roots = params.roots ?? listTsdownOutputRoots();
  const rootPaths = roots.map((root) => pathImpl.resolve(cwd, root));
  for (const rootPath of rootPaths) {
    if (pathImpl.parse(rootPath).root === rootPath) {
      throw new Error(
        "Cannot clean a filesystem root. Please specify a dedicated output directory.",
      );
    }
    if (isPathInside(rootPath, cwd)) {
      throw new Error(
        "Cannot clean the current working directory or one of its ancestors. Please specify a dedicated output directory.",
      );
    }
    if (isPathInside(rootPath, resolveDistArtifactLockPath(cwd))) {
      throw new Error("Cannot clean the checkout's dist artifact ownership location.");
    }
    // A safe final component is insufficient: recursive removal follows symlinked parents.
    // Validate every component below the nearest common ancestor before any mutation begins.
    let candidatePath = rootPath;
    while (!isPathInside(candidatePath, cwd)) {
      assertRealOutputRoot(candidatePath, { fs: fsImpl });
      const parentPath = pathImpl.dirname(candidatePath);
      if (parentPath === candidatePath) {
        break;
      }
      candidatePath = parentPath;
    }
  }
  return rootPaths;
}

export function cleanTsdownOutputRoots(params: OutputRootParams = {}) {
  const pathImpl = params.pathImpl ?? path;
  const cwd = pathImpl.resolve(params.cwd ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const env = params.env ?? process.env;
  const roots = params.roots ?? listTsdownOutputRoots();
  // Validate the complete mutation set before traversing protected children or
  // cleaning any earlier root; otherwise a later symlink can leave a partial build.
  const rootPaths = assertTsdownCleanOutputRoots({ cwd, fs: fsImpl, pathImpl, roots });
  const protectedDeclarationPaths =
    env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? listExistingGeneratedDeclarationOutputPaths(cwd, fsImpl, roots)
      : new Set<string>();
  const protectedPaths = new Set([
    ...protectedDeclarationPaths,
    ...listExistingPreservedOutputPaths(cwd, env, fsImpl),
  ]);
  for (const rootPath of rootPaths) {
    try {
      if (hasProtectedChild(rootPath, protectedPaths)) {
        cleanOutputRootExcept(rootPath, protectedPaths, fsImpl);
      } else {
        fsImpl.rmSync(rootPath, { force: true, recursive: true });
      }
    } catch {
      // Best-effort cleanup. tsdown will recreate the output tree it needs.
    }
  }
}

function hasProtectedChild(rootPath: string, protectedPaths: Set<string>) {
  const rootWithSeparator = `${path.resolve(rootPath)}${path.sep}`;
  for (const protectedPath of protectedPaths) {
    if (protectedPath.startsWith(rootWithSeparator)) {
      return true;
    }
  }
  return false;
}

function cleanOutputRootExcept(rootPath: string, protectedPaths: Set<string>, fsImpl: typeof fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const resolvedEntryPath = path.resolve(entryPath);
    if (protectedPaths.has(resolvedEntryPath)) {
      continue;
    }
    try {
      if (entry.isDirectory()) {
        cleanOutputRootExcept(entryPath, protectedPaths, fsImpl);
        fsImpl.rmdirSync(entryPath);
      } else {
        fsImpl.rmSync(entryPath, { force: true });
      }
    } catch {
      // Keep best-effort semantics; protected children can keep a directory non-empty.
    }
  }
}

function listExistingGeneratedDeclarationOutputPaths(
  cwd: string,
  fsImpl: typeof fs,
  roots: string[],
) {
  const protectedPaths = new Set<string>();
  for (const root of roots) {
    collectDeclarationOutputPaths(path.resolve(cwd, root), protectedPaths, fsImpl);
  }
  // Copied SDK types belong to the runtime package: JS builds replace them,
  // while declaration publication (including cache restores) must leave them intact.
  const runtimeAssetRoots = roots.map((root) =>
    path.resolve(cwd, root, CLAUDE_AGENT_SDK_ASSET_DIR),
  );
  return new Set(
    [...protectedPaths].filter(
      (file) => !runtimeAssetRoots.some((root) => isPathInside(root, file)),
    ),
  );
}

function listExistingPreservedOutputPaths(cwd: string, env: NodeJS.ProcessEnv, fsImpl: typeof fs) {
  // Vite owns and cleans this subtree; tsdown cannot recreate its assets.
  const protectedPaths = new Set([path.resolve(cwd, "dist/control-ui")]);
  // Mac packaging owns replacement of signed bundles. Rebuilding its JS must
  // leave the previous app (including its private runtime) usable on failure.
  const pendingDirectories = [path.join(cwd, "dist")];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    if (!fsImpl.existsSync(directory)) {
      continue;
    }
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(directory, entry.name);
      if (entry.name.endsWith(".app")) {
        protectedPaths.add(child);
      } else {
        pendingDirectories.push(child);
      }
    }
  }
  if (env[PRESERVE_CLI_STARTUP_METADATA_ENV] !== "1") {
    return protectedPaths;
  }
  for (const relativePath of PRESERVED_TSDOWN_OUTPUT_FILES) {
    const absolutePath = path.resolve(cwd, relativePath);
    try {
      if (fsImpl.statSync(absolutePath).isFile()) {
        protectedPaths.add(absolutePath);
      }
    } catch {
      // Missing preserved outputs are normal on first build.
    }
  }
  return protectedPaths;
}

/** Publish generated declarations without claiming runtime assets or protected subtrees. */
export function listReplaceableTsdownDeclarationOutputs(params: OutputRootParams = {}) {
  const cwd = path.resolve(params.cwd ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  const roots = params.roots ?? listTsdownOutputRoots();
  assertTsdownCleanOutputRoots({ ...params, cwd, fs: fsImpl, roots });
  const protectedPaths = [
    ...listExistingPreservedOutputPaths(cwd, params.env ?? process.env, fsImpl),
  ];
  return [...listExistingGeneratedDeclarationOutputPaths(cwd, fsImpl, roots)]
    .filter(
      (file) =>
        !protectedPaths.some(
          (protectedPath) =>
            file === protectedPath || file.startsWith(`${protectedPath}${path.sep}`),
        ),
    )
    .toSorted();
}

function collectDeclarationOutputPaths(
  rootPath: string,
  protectedPaths: Set<string>,
  fsImpl: typeof fs,
) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectDeclarationOutputPaths(entryPath, protectedPaths, fsImpl);
    } else if (TSDOWN_DECLARATION_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      protectedPaths.add(path.resolve(entryPath));
    }
  }
}

export function pruneStaleRootChunkFiles(params: Pick<OutputRootParams, "cwd" | "fs"> = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const roots = listTsdownOutputRoots().map((root) => path.join(cwd, root));
  for (const root of roots) {
    assertRealOutputRoot(root, { fs: fsImpl });
  }
  for (const root of roots) {
    let entries;
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!HASHED_ROOT_JS_RE.test(entry.name)) {
        continue;
      }
      try {
        fsImpl.rmSync(path.join(root, entry.name), { force: true });
      } catch {
        // Best-effort cleanup. The subsequent build will overwrite any stragglers.
      }
    }
  }
}

export function listTsdownOutputRoots() {
  return [...ROOT_TSDOWN_OUTPUT_ROOTS, ...TSDOWN_PACKAGE_OUTPUT_ROOTS];
}

function readForwardedOptions(args: string[], names: string[]) {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error(`tsdown build requires one concrete ${names.join("/")} value`);
        }
        values.push(value);
      } else if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (!value) {
          throw new Error(`tsdown build requires one concrete ${names.join("/")} value`);
        }
        values.push(value);
      }
    }
  }
  return values;
}
const readForwardedOption = (args: string[], names: string[]) =>
  readForwardedOptions(args, names)[0];
function readForwardedScalarOption(args: string[], names: string[], label: string) {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error(`tsdown build requires one concrete ${label} value`);
        }
        values.push(value);
      } else if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (!value) {
          throw new Error(`tsdown build requires one concrete ${label} value`);
        }
        values.push(value);
      }
    }
  }
  if (values.length > 1) {
    throw new Error(`tsdown build accepts only one ${label} value`);
  }
  return values[0];
}
const isFilterFlag = (arg: string | undefined) => arg === "--filter" || arg === "-F";
const isFilterArg = (arg: string) =>
  isFilterFlag(arg) || arg.startsWith("--filter=") || arg.startsWith("-F=");
const isConfigArg = (arg: string) =>
  arg === "--config" ||
  arg.startsWith("--config=") ||
  arg === "-c" ||
  arg.startsWith("-c=") ||
  arg === "--no-config";
const isWatchArg = (arg: string) =>
  arg === "--watch" || arg.startsWith("--watch=") || arg === "-w" || arg.startsWith("-w=");
const isUnifiedDtsGroup = (value: string | undefined) =>
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.some((group) => group === value);

/** Limits cleanup to the output roots owned by an explicitly filtered build. */
export function resolveTsdownCleanOutputRoots(args: string[] = []) {
  const config = readForwardedOption(args, ["--config", "-c"]);
  const outDir = readForwardedScalarOption(args, ["--out-dir", "-d"], "--out-dir/-d");
  const filters = readForwardedOptions(args, ["--filter", "-F"]);
  const configPath = config ? path.resolve(config) : undefined;
  const aiConfigPath = path.resolve("tsdown.ai.config.ts");
  const aiRoot = tsdownPackageOutputRoot("ai");
  const packageRoots = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter((root) => root !== aiRoot);
  const selectsRootCwd = filters.includes(".");
  const selectedMainRoots = [
    ...(filters.includes(TSDOWN_PACKAGE_CONFIG_GROUP) ? packageRoots : []),
    ...(filters.some(
      (filter) => filter === TSDOWN_UNIFIED_CONFIG_GROUP || isUnifiedDtsGroup(filter),
    )
      ? ROOT_TSDOWN_OUTPUT_ROOTS
      : []),
  ];

  if (outDir !== undefined) {
    return [outDir];
  }
  if (configPath === aiConfigPath) {
    return [aiRoot];
  }
  if (selectsMainConfig(args)) {
    return filters.length === 0 || selectsRootCwd || selectedMainRoots.length === 0
      ? [...ROOT_TSDOWN_OUTPUT_ROOTS, ...packageRoots]
      : selectedMainRoots;
  }
  if (!config && selectsRootCwd) {
    return listTsdownOutputRoots();
  }
  if (!config && filters.length > 0 && selectedMainRoots.length > 0) {
    return [aiRoot, ...selectedMainRoots];
  }
  return listTsdownOutputRoots();
}

function wrapperOwnsTsdownCleanup(args: string[]) {
  if (readForwardedScalarOption(args, ["--out-dir", "-d"], "--out-dir/-d") !== undefined) {
    return true;
  }
  const config = readForwardedOption(args, ["--config", "-c"]);
  if (config === undefined) {
    return true;
  }
  return path.resolve(config) === path.resolve("tsdown.ai.config.ts") || selectsMainConfig(args);
}

type GitLsFilesResult = Pick<SpawnSyncReturns<string>, "status"> & { stdout?: string };

export function pruneUntrackedGeneratedSourceDeclarations(
  params: {
    cwd?: string;
    fs?: typeof fs;
    spawnSync?: (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => GitLsFilesResult;
  } = {},
) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  let result;
  try {
    result = spawnSyncImpl(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", GENERATED_SOURCE_DECLARATION_PATHSPEC],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return 0;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return 0;
  }

  let removed = 0;
  for (const rawPath of result.stdout.split(/\r?\n/u)) {
    const relativePath = rawPath.trim().replaceAll("\\", "/");
    if (!relativePath.startsWith("extensions/") || !relativePath.endsWith(".d.ts")) {
      continue;
    }
    const declarationPath = path.join(cwd, relativePath);
    const sourceBase = declarationPath.slice(0, -".d.ts".length);
    const hasMatchingSource = SOURCE_DECLARATION_SOURCE_EXTENSIONS.some((extension) =>
      fsImpl.existsSync(`${sourceBase}${extension}`),
    );
    if (!hasMatchingSource) {
      continue;
    }
    try {
      fsImpl.rmSync(declarationPath, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup; tsdown will still report any remaining stale files.
    }
  }
  return removed;
}

function findFatalUnresolvedImport(lines: string[]) {
  for (const line of lines) {
    if (!line.includes("[UNRESOLVED_IMPORT]")) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (
      !normalizedLine.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !DEPENDENCY_PATH_MARKERS.some((marker) => normalizedLine.includes(marker))
    ) {
      return normalizedLine;
    }
  }

  return null;
}

function parsePositiveIntegerEnv(value: string | undefined, name: string) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return parsePositiveInt(value, name);
}

function parseNonNegativeIntegerEnv(value: string | undefined, name: string) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const text = value.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseCgroupMemoryLimitBytes(value: string) {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "max" || !/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readProcessRlimitMemoryBytes(params: MemoryLimitParams) {
  if ((params.platform ?? process.platform) !== "linux") {
    return null;
  }
  try {
    const rawLimits = (params.fs ?? fs).readFileSync(PROC_SELF_LIMITS_PATH, "utf8");
    let tightestLimitBytes: number | null = null;
    for (const match of rawLimits.matchAll(
      /^Max (?:address space|data size)\s+(?<soft>\d+|unlimited)\s+/gmu,
    )) {
      const softLimit = match.groups?.soft;
      if (!softLimit || softLimit === "unlimited") {
        continue;
      }
      const parsed = parseCgroupMemoryLimitBytes(softLimit);
      if (parsed !== null && (tightestLimitBytes === null || parsed < tightestLimitBytes)) {
        tightestLimitBytes = parsed;
      }
    }
    return tightestLimitBytes;
  } catch {
    return null;
  }
}

function parseCgroupInactiveFileBytes(value: string, isV1: boolean) {
  const match = isV1
    ? (value.match(/^total_inactive_file\s+(\d+)$/mu) ?? value.match(/^inactive_file\s+(\d+)$/mu))
    : value.match(/^inactive_file\s+(\d+)$/mu);
  return match?.[1] ? parseCgroupMemoryLimitBytes(match[1]) : 0;
}

function readProcessResidentMemoryBytes(params: MemoryLimitParams) {
  const configured = params.processResidentMemoryBytes;
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) {
    return Math.trunc(configured);
  }
  try {
    const match = (params.fs ?? fs)
      .readFileSync(PROC_SELF_STATUS_PATH, "utf8")
      .match(/^VmRSS:\s+(\d+)\s+kB$/mu);
    const bytes = match?.[1] ? BigInt(match[1]) * 1024n : null;
    return bytes !== null && bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
  } catch {
    return null;
  }
}

// Controller mount points are host layout, not constants: v1 controllers may be co-mounted at
// the cgroup root instead of a per-controller directory. Read them where the kernel records
// them so a slice budget is never missed because a path was assumed.
function resolveCgroupMountPoints(params: MemoryLimitParams = {}) {
  const fsImpl = params.fs ?? fs;
  let rawMountinfo = "";
  try {
    rawMountinfo = fsImpl.readFileSync(PROC_SELF_MOUNTINFO_PATH, "utf8");
  } catch {
    // Unreadable off Linux; the documented defaults still apply.
  }

  // One hierarchy can be visible through several mounts, and only some of them expose a subtree
  // containing this process, so every view is kept as a candidate rather than the last one seen.
  const unified: CgroupMount[] = [];
  const v1Memory: CgroupMount[] = [];
  for (const line of rawMountinfo.split("\n")) {
    // mountinfo separates its variable optional fields from the fstype with a lone "-".
    const [fields, describe] = line.split(" - ");
    // mountinfo fields 4 and 5 are the mount root and mount point.
    const mountFields = (fields ?? "").split(" ");
    const rawRoot = mountFields[3];
    const rawMountPoint = mountFields[4];
    const [fsType, , superOptions] = (describe ?? "").split(" ");
    if (!rawMountPoint || !rawRoot) {
      continue;
    }
    // The kernel escapes space, tab, newline, and backslash in these two fields, so
    // matching them verbatim would miss any cgroup path containing one of them.
    const root = decodeMountInfoPath(rawRoot);
    const mountPoint = decodeMountInfoPath(rawMountPoint);
    if (fsType === "cgroup2") {
      unified.push({ mountPoint, observed: true, root });
    } else if (fsType === "cgroup" && (superOptions ?? "").split(",").includes("memory")) {
      v1Memory.push({ mountPoint, observed: true, root });
    }
  }
  return {
    unified:
      unified.length > 0
        ? unified
        : [{ mountPoint: DEFAULT_CGROUP_V2_MOUNT_PATH, observed: false, root: "/" }],
    v1Memory:
      v1Memory.length > 0
        ? v1Memory
        : [{ mountPoint: DEFAULT_CGROUP_V1_MEMORY_MOUNT_PATH, observed: false, root: "/" }],
  };
}

// mountinfo field 4 is the subtree a cgroupfs mount exposes, so /proc/self/cgroup records are
// relative to it: under a container mount the visible leaf is the mount point itself, not the
// host-absolute path. A record outside that subtree is not reachable through this mount, and
// probing the mount root instead would size the build from an unrelated cgroup's limit.
function relativeCgroupPath(mountRoot: string, cgroupPath: string) {
  if (cgroupPath.split("/").includes("..")) {
    return null;
  }
  if (mountRoot === "/") {
    return cgroupPath;
  }
  const mountRootSegments = mountRoot.split("/").filter(Boolean);
  if (mountRootSegments.length > 0 && mountRootSegments.every((segment) => segment === "..")) {
    // The visible root is an ancestor, but the process's hidden child name cannot be
    // reconstructed. Treat it as unresolved instead of mistaking the parent for the leaf.
    return null;
  }
  if (mountRootSegments.includes("..")) {
    return null;
  }
  // A namespace-root record proves nothing about a mount rooted elsewhere: the kernel
  // contract does not make "/" plus an arbitrary subtree a match, so adopting that pair
  // could cap the heap from an unrelated cgroup. Fail closed to host sizing instead.
  if (cgroupPath === "/") {
    return null;
  }
  if (cgroupPath === mountRoot) {
    return "/";
  }
  return cgroupPath.startsWith(`${mountRoot}/`) ? cgroupPath.slice(mountRoot.length) : null;
}

// A systemd slice budget lives on the process's own cgroup, never on a hierarchy root, so
// probing only the root misses every limit outside a namespaced container. Legacy and hybrid
// hosts publish that same budget through the v1 memory controller instead of the `0::` record,
// so both hierarchies are walked leaf-to-root; depth 0 is the root probe.
function resolveCgroupMemoryLimitPaths(params: MemoryLimitParams = {}) {
  const fsImpl = params.fs ?? fs;
  let rawCgroup = "";
  let cgroupRecordReadFailed = false;
  try {
    rawCgroup = fsImpl.readFileSync(PROC_SELF_CGROUP_PATH, "utf8");
  } catch {
    cgroupRecordReadFailed = (params.platform ?? process.platform) === "linux";
  }

  const paths: string[] = [];
  const addHierarchy = (
    mounts: CgroupMount[],
    limitFiles: string[],
    cgroupPath: string,
    hierarchyFile?: string,
  ) => {
    const initialPathCount = paths.length;
    let addedObservedPath = false;
    let hierarchyMetadataUnreadable = false;
    for (const mount of mounts) {
      const mountInitialPathCount = paths.length;
      const mountRootSegments = mount.root.split("/").filter(Boolean);
      if (mountRootSegments.length > 0 && mountRootSegments.every((segment) => segment === "..")) {
        continue;
      }
      const relative = relativeCgroupPath(mount.root, cgroupPath ?? mount.root);
      if (relative === null) {
        continue;
      }
      const segments = relative.split("/").filter(Boolean);
      for (let depth = segments.length; depth >= 0; depth -= 1) {
        if (hierarchyFile && depth < segments.length) {
          try {
            const hierarchyPath = path.join(
              mount.mountPoint,
              ...segments.slice(0, depth),
              hierarchyFile,
            );
            const hierarchyMode = fsImpl.readFileSync(hierarchyPath, "utf8").trim();
            if (hierarchyMode === "0") {
              break;
            }
            if (hierarchyMode !== "1") {
              hierarchyMetadataUnreadable = true;
              break;
            }
          } catch {
            hierarchyMetadataUnreadable = true;
            break;
          }
        }
        for (const limitFile of limitFiles) {
          paths.push(path.join(mount.mountPoint, ...segments.slice(0, depth), limitFile));
        }
      }
      addedObservedPath ||= mount.observed && paths.length > mountInitialPathCount;
    }
    return {
      added: paths.length > initialPathCount,
      addedObservedPath,
      hierarchyMetadataUnreadable,
    };
  };

  const mounts = resolveCgroupMountPoints(params);
  let sawMemoryRecord = false;
  let sawObservedV2Mapping = false;
  let sawObservedV2Root = false;
  let sawUnreadableV1HierarchyMetadata = false;
  let sawV1MemoryRecord = false;
  let sawRejectedCgroupMapping = false;
  let sawUnresolvedCgroupLimit = false;
  for (const line of rawCgroup.split("\n")) {
    const record = /^\d+:([^:]*):(.*)$/u.exec(line);
    if (!record) {
      continue;
    }
    const controllers = record[1] ?? "";
    if (controllers === "") {
      sawMemoryRecord = true;
      const cgroupPath = record[2] ?? "";
      sawObservedV2Root ||=
        cgroupPath === "/" && mounts.unified.some((mount) => mount.observed && mount.root === "/");
      const resolved = addHierarchy(mounts.unified, CGROUP_V2_MEMORY_LIMIT_FILES, cgroupPath);
      sawObservedV2Mapping ||= resolved.addedObservedPath;
      sawRejectedCgroupMapping ||= !resolved.added;
      sawUnresolvedCgroupLimit ||= !resolved.added;
    } else if (controllers.split(",").includes("memory")) {
      sawMemoryRecord = true;
      sawV1MemoryRecord = true;
      const resolved = addHierarchy(
        mounts.v1Memory,
        CGROUP_V1_MEMORY_LIMIT_FILES,
        record[2] ?? "",
        "memory.use_hierarchy",
      );
      sawUnreadableV1HierarchyMetadata ||= resolved.hierarchyMetadataUnreadable;
      sawRejectedCgroupMapping ||= !resolved.added;
      sawUnresolvedCgroupLimit ||= !resolved.added;
    }
  }
  // Only probe the mounts blind when this process has no memory cgroup record at all; a record
  // that no mount can represent means the limit is unreadable here, not that the root applies.
  if (!sawMemoryRecord) {
    for (const mount of mounts.unified) {
      addHierarchy([mount], CGROUP_V2_MEMORY_LIMIT_FILES, mount.root);
    }
    for (const mount of mounts.v1Memory) {
      addHierarchy([mount], CGROUP_V1_MEMORY_LIMIT_FILES, mount.root);
    }
  }
  return {
    paths,
    cgroupRecordReadFailed,
    sawMemoryRecord,
    sawObservedV2Mapping,
    sawObservedUnconstrainedV2Root: sawObservedV2Root && !sawV1MemoryRecord,
    sawRejectedCgroupMapping,
    sawUnresolvedCgroupLimit,
    sawUnreadableV1HierarchyMetadata,
    sawV1MemoryRecord,
  };
}

function readCgroupMemoryLimitBytes(params: MemoryLimitParams = {}) {
  const configuredLimit = params.cgroupMemoryLimitBytes;
  if (configuredLimit !== undefined && Number.isFinite(configuredLimit) && configuredLimit >= 0) {
    return { limitBytes: Math.trunc(configuredLimit), unresolved: false };
  }

  const fsImpl = params.fs ?? fs;
  const resolvedPaths = params.cgroupMemoryLimitPaths
    ? {
        cgroupRecordReadFailed: false,
        paths: params.cgroupMemoryLimitPaths,
        sawMemoryRecord: false,
        sawObservedV2Mapping: false,
        sawObservedUnconstrainedV2Root: false,
        sawRejectedCgroupMapping: false,
        sawUnresolvedCgroupLimit: false,
        sawUnreadableV1HierarchyMetadata: false,
        sawV1MemoryRecord: false,
      }
    : resolveCgroupMemoryLimitPaths(params);
  // libuv folds cgroup v1's advisory soft limit into constrainedMemory(). Preserve its separate
  // process rlimit candidate while the owner walk reads only authoritative cgroup hard limits.
  const rlimitMemoryBytes = readProcessRlimitMemoryBytes(params);
  const constrainedMemoryBytes =
    resolvedPaths.sawV1MemoryRecord ||
    resolvedPaths.sawRejectedCgroupMapping ||
    resolvedPaths.sawUnresolvedCgroupLimit ||
    resolvedPaths.sawUnreadableV1HierarchyMetadata
      ? 0
      : (params.constrainedMemoryBytes ??
        (params.fs === undefined ? process.constrainedMemory() : 0));
  // An ancestor may bound the leaf, so the tightest limit in the chain wins.
  let tightestLimitBytes =
    Number.isFinite(constrainedMemoryBytes) && constrainedMemoryBytes > 0
      ? Math.trunc(constrainedMemoryBytes)
      : null;
  if (
    rlimitMemoryBytes !== null &&
    (tightestLimitBytes === null || rlimitMemoryBytes < tightestLimitBytes)
  ) {
    tightestLimitBytes = rlimitMemoryBytes;
  }
  const processResidentMemoryBytes = readProcessResidentMemoryBytes(params);
  let readControllerLimit = false;
  let readV1HardLimit = false;
  let sawDisabledV2MemoryController = false;
  let sawUnreadableControllerFile = false;
  for (const limitPath of resolvedPaths.paths) {
    try {
      const rawLimit = fsImpl.readFileSync(limitPath, "utf8");
      const trimmedLimit = rawLimit.trim();
      readControllerLimit ||= trimmedLimit === "max" || /^\d+$/u.test(trimmedLimit);
      // A controller cannot be bound to v1 and v2 simultaneously. Reading the v1 hard-limit
      // file therefore resolves memory ownership even when its value is the unlimited sentinel.
      if (path.basename(limitPath) === "memory.limit_in_bytes" && /^\d+$/u.test(trimmedLimit)) {
        readV1HardLimit = true;
      }
      const limitBytes = parseCgroupMemoryLimitBytes(rawLimit);
      if (limitBytes === null) {
        continue;
      }
      let availableBytes = limitBytes;
      try {
        const isV1 = path.basename(limitPath) === "memory.limit_in_bytes";
        const cgroupDir = path.dirname(limitPath);
        const usageBytes = parseCgroupMemoryLimitBytes(
          fsImpl.readFileSync(
            path.join(cgroupDir, isV1 ? "memory.usage_in_bytes" : "memory.current"),
            "utf8",
          ),
        );
        if (usageBytes !== null) {
          let inactiveFileBytes = 0;
          try {
            inactiveFileBytes =
              parseCgroupInactiveFileBytes(
                fsImpl.readFileSync(path.join(cgroupDir, "memory.stat"), "utf8"),
                isV1,
              ) ?? 0;
          } catch {
            // Missing stats make all charged usage non-reclaimable for admission.
          }
          // Total controller usage includes kernel and unreclaimable file charges. Credit only
          // inactive file pages and this wrapper's resident set before sizing its child.
          const competingBytes = Math.max(
            0,
            usageBytes -
              Math.min(usageBytes, inactiveFileBytes) -
              (processResidentMemoryBytes ?? 0),
          );
          availableBytes = Math.max(0, limitBytes - competingBytes);
        }
      } catch {
        // Older or synthetic cgroup views may not expose current usage; the limit remains a cap.
      }
      if (tightestLimitBytes === null || availableBytes < tightestLimitBytes) {
        tightestLimitBytes = availableBytes;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        sawUnreadableControllerFile = true;
        continue;
      }
      if (path.basename(limitPath) === "memory.limit_in_bytes") {
        continue;
      }
      try {
        const controllers = fsImpl
          .readFileSync(path.join(path.dirname(limitPath), "cgroup.controllers"), "utf8")
          .trim()
          .split(/\s+/u)
          .filter(Boolean);
        sawDisabledV2MemoryController ||= !controllers.includes("memory");
      } catch (controllerError) {
        sawUnreadableControllerFile ||= !isMissingFileError(controllerError);
      }
    }
  }

  return {
    limitBytes: tightestLimitBytes,
    unresolved:
      resolvedPaths.cgroupRecordReadFailed ||
      sawUnreadableControllerFile ||
      resolvedPaths.sawUnreadableV1HierarchyMetadata ||
      (resolvedPaths.sawUnresolvedCgroupLimit && !readV1HardLimit) ||
      (resolvedPaths.sawMemoryRecord &&
        !readControllerLimit &&
        !resolvedPaths.sawObservedUnconstrainedV2Root &&
        !(
          resolvedPaths.sawObservedV2Mapping &&
          sawDisabledV2MemoryController &&
          !sawUnreadableControllerFile
        )),
  };
}

function parseProcMemoryBytes(value: string, field: "MemAvailable" | "MemTotal") {
  const match = value.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "imu"));
  const kibibytes = match?.[1];
  if (!kibibytes) {
    return null;
  }
  const parsed = BigInt(kibibytes) * 1024n;
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function readProcMemTotalBytes(params: MemoryLimitParams = {}) {
  const configuredTotal = params.procMemTotalBytes;
  if (configuredTotal && Number.isFinite(configuredTotal) && configuredTotal > 0) {
    return Math.trunc(configuredTotal);
  }

  const fsImpl = params.fs ?? fs;
  try {
    return parseProcMemoryBytes(
      fsImpl.readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
      "MemTotal",
    );
  } catch {
    return null;
  }
}

function readPhysicalMemoryTotalBytes(params: MemoryLimitParams = {}) {
  const totalBytes = params.physicalMemoryBytes ?? os.totalmem();
  return Number.isFinite(totalBytes) && totalBytes > 0 ? Math.trunc(totalBytes) : null;
}

function readHostAvailableMemoryBytes(params: MemoryLimitParams) {
  if (params.availableMemoryBytes !== undefined) {
    return Number.isFinite(params.availableMemoryBytes) && params.availableMemoryBytes >= 0
      ? Math.trunc(params.availableMemoryBytes)
      : null;
  }
  if ((params.platform ?? process.platform) === "linux") {
    try {
      return parseProcMemoryBytes(
        (params.fs ?? fs).readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
        "MemAvailable",
      );
    } catch {
      return null;
    }
  }
  return null;
}

function resolveTsdownMemoryBudget(params: ResolvedMemoryLimitParams = {}) {
  if (params.resolvedMaxOldSpaceMb !== undefined) {
    return { maxOldSpaceMb: params.resolvedMaxOldSpaceMb, unresolvedCgroupMemory: false };
  }
  const defaultMaxOldSpaceMb =
    (params.platform ?? process.platform) === "win32"
      ? DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB
      : DEFAULT_TSDOWN_MAX_OLD_SPACE_MB;
  const envOverride = parsePositiveIntegerEnv(
    (params.env ?? process.env)[TSDOWN_MAX_OLD_SPACE_MB_ENV],
    TSDOWN_MAX_OLD_SPACE_MB_ENV,
  );
  if (envOverride !== null) {
    return { maxOldSpaceMb: envOverride, unresolvedCgroupMemory: false };
  }

  const cgroupMemory = readCgroupMemoryLimitBytes(params);
  if (cgroupMemory.unresolved) {
    return { maxOldSpaceMb: 1, unresolvedCgroupMemory: true };
  }
  const physicalTotalBytes = readProcMemTotalBytes(params) ?? readPhysicalMemoryTotalBytes(params);
  const hostAvailableBytes = readHostAvailableMemoryBytes(params);
  const physicalLimitBytes =
    hostAvailableBytes === null || physicalTotalBytes === null
      ? (hostAvailableBytes ?? physicalTotalBytes)
      : Math.min(hostAvailableBytes, physicalTotalBytes);
  const limitBytes =
    cgroupMemory.limitBytes === null || physicalLimitBytes === null
      ? (cgroupMemory.limitBytes ?? physicalLimitBytes)
      : Math.min(cgroupMemory.limitBytes, physicalLimitBytes);
  if (limitBytes === null) {
    return { maxOldSpaceMb: defaultMaxOldSpaceMb, unresolvedCgroupMemory: false };
  }

  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  // Never exceed the budget just discovered: a floor applied on top of a real limit produces
  // a heap the cgroup cannot honour, which is an OOM kill rather than a smaller build.
  const cgroupCap = Math.max(1, limitMb - TSDOWN_CGROUP_MEMORY_HEADROOM_MB);
  return {
    maxOldSpaceMb: Math.min(defaultMaxOldSpaceMb, cgroupCap),
    unresolvedCgroupMemory: false,
  };
}

const resolveTsdownMaxOldSpaceMb = (params: ResolvedMemoryLimitParams = {}) =>
  resolveTsdownMemoryBudget(params).maxOldSpaceMb;

/**
 * Measured against this repo by running the full eleven-invocation build inside real cgroups.
 * A 5GiB slice resolves this heap, completes, and peaks at 4730MiB. A 4GiB slice (3328MB heap)
 * and a 2816MiB slice (2048MB heap) are both killed in the third, unified-runtime invocation,
 * which also runs when declarations are disabled. Roughly 380MiB of the peak is rolldown, a
 * native addon which --max-old-space-size does not govern at all.
 */
const MEASURED_MIN_TSDOWN_HEAP_MB = 4352;

/**
 * Describes a host that cannot fit the build, or null when it can. Reported before any
 * output is cleaned: a host that cannot rebuild must not also lose the build it already
 * has. Fatal by default because continuing either aborts partway through the invocation
 * list or, when the heap outruns a container limit, thrashes at the ceiling instead of
 * failing, which starves every other process on the machine.
 */
export function describeInsufficientTsdownHeap(
  params: ResolvedMemoryLimitParams = {},
  budget = resolveTsdownMemoryBudget(params),
) {
  const { maxOldSpaceMb } = budget;
  if (maxOldSpaceMb >= MEASURED_MIN_TSDOWN_HEAP_MB) {
    return null;
  }
  const env = params.env ?? process.env;
  const explicitHeapMb = parsePositiveIntegerEnv(
    env[TSDOWN_MAX_OLD_SPACE_MB_ENV],
    TSDOWN_MAX_OLD_SPACE_MB_ENV,
  );
  const heapOverrideEnv = Object.hasOwn(env, "OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS")
    ? DOCKER_TSDOWN_MAX_OLD_SPACE_MB_ENV
    : TSDOWN_MAX_OLD_SPACE_MB_ENV;
  const fatal = explicitHeapMb === null;
  const outcome = fatal
    ? budget.unresolvedCgroupMemory
      ? [
          "Stopping before any build output is removed. Pick one:",
          "  - run the build where the process cgroup limit is visible",
          `  - set ${heapOverrideEnv}=<MB> to explicitly attempt the build anyway`,
        ]
      : [
          "Stopping before any build output is removed. Pick one:",
          "  - give this machine or container more memory",
          `  - set ${heapOverrideEnv}=<MB> to explicitly attempt the build anyway`,
        ]
    : [
        `Continuing because ${heapOverrideEnv} explicitly requests ${explicitHeapMb}MB. Existing build output will now be cleaned; the build may stall or fail.`,
      ];
  return {
    fatal,
    message: [
      budget.unresolvedCgroupMemory
        ? "[tsdown-build] The process memory limit is not visible through this cgroup mount namespace, so OpenClaw cannot choose a safe default heap."
        : `[tsdown-build] The resolved OpenClaw build heap is ${maxOldSpaceMb}MB, ` +
          `and a full build needs ${MEASURED_MIN_TSDOWN_HEAP_MB}MB, peaking near 4.7GB once rolldown's ` +
          `native allocations are counted; those are not covered by --max-old-space-size.`,
      ...outcome,
    ].join("\n"),
  };
}

function parseMaxOldSpaceSizeMb(value: unknown, fallbackMb: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMb;
  }
  return Math.trunc(parsed);
}

function normalizeMaxOldSpaceSizeMb(value: unknown, maxOldSpaceMb: number) {
  // Build wrappers may inherit smaller runner-level caps; tsdown needs the
  // resolved build heap while still respecting cgroup-derived upper bounds.
  const parsed = parseMaxOldSpaceSizeMb(value, maxOldSpaceMb);
  if (parsed < maxOldSpaceMb) {
    return maxOldSpaceMb;
  }
  return Math.min(parsed, maxOldSpaceMb);
}

function normalizeTsdownNodeOptions(nodeOptions: string, params: ResolvedMemoryLimitParams = {}) {
  const maxOldSpaceMb = resolveTsdownMaxOldSpaceMb(params);
  const parts = nodeOptions.trim().split(/\s+/u).filter(Boolean);
  const normalized: string[] = [];
  let foundMaxOldSpaceSize = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      continue;
    }
    const inlineMatch = part.match(/^--max-old-space-size=(\d+)$/u);
    if (inlineMatch) {
      foundMaxOldSpaceSize = true;
      const value = normalizeMaxOldSpaceSizeMb(inlineMatch[1], maxOldSpaceMb);
      normalized.push(`--max-old-space-size=${value}`);
      continue;
    }

    if (part === "--max-old-space-size") {
      foundMaxOldSpaceSize = true;
      const next = parts[index + 1];
      const value = normalizeMaxOldSpaceSizeMb(next, maxOldSpaceMb);
      normalized.push(`--max-old-space-size=${value}`);
      if (next !== undefined) {
        index += 1;
      }
      continue;
    }

    normalized.push(part);
  }

  if (!foundMaxOldSpaceSize) {
    normalized.push(`--max-old-space-size=${maxOldSpaceMb}`);
  }

  return normalized.join(" ");
}

function resolveTsdownEnv(
  env: NodeJS.ProcessEnv,
  params: ResolvedMemoryLimitParams = {},
): NodeJS.ProcessEnv {
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  return {
    ...env,
    NODE_OPTIONS: normalizeTsdownNodeOptions(nodeOptions, params),
  };
}

function tsdownBuildUsage() {
  return [
    "Usage: node --import tsx scripts/tsdown-build.mts [tsdown args...]",
    "",
    "Builds OpenClaw with tsdown and validates emitted import diagnostics.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting tsdown.",
    "",
    "Other arguments are forwarded to tsdown.",
  ].join("\n");
}

export function parseTsdownBuildArgs(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      forwardedArgs: [],
      help: true,
    };
  }
  return {
    forwardedArgs: argv,
    help: false,
  };
}

export function createTsdownOutputScanner(params: { maxCaptureBytes?: number } = {}) {
  const maxCaptureBytes = params.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
  let captured = "";
  let pendingLine = "";
  let hasIneffectiveDynamicImport = false;
  let fatalUnresolvedImport: string | null = null;

  function scanLines(text: string) {
    const combined = pendingLine + text;
    const lines = combined.split(/\r?\n/u);
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      fatalUnresolvedImport ??= findFatalUnresolvedImport([line]);
    }
  }

  return {
    append(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(INEFFECTIVE_DYNAMIC_IMPORT_MARKER)) {
        hasIneffectiveDynamicImport = true;
      }
      scanLines(text);
      captured += text;
      if (captured.length > maxCaptureBytes) {
        captured = captured.slice(-maxCaptureBytes);
      }
    },
    finish() {
      if (pendingLine) {
        fatalUnresolvedImport ??= findFatalUnresolvedImport([pendingLine]);
        pendingLine = "";
      }
      return {
        captured,
        hasIneffectiveDynamicImport,
        fatalUnresolvedImport,
      };
    },
  };
}

export function resolveTsdownBuildInvocation(
  params: TsdownBuildParams = {},
): TsdownBuildInvocation {
  const env = resolveTsdownEnv(params.env ?? process.env, params);
  const args = params.args ?? [];
  const forwardedArgs = wrapperOwnsTsdownCleanup(args)
    ? args.filter((arg) => arg !== "--clean" && !arg.startsWith("--clean="))
    : args;
  const tsdownArgs = [
    "--config-loader",
    "unrun",
    "--logLevel",
    logLevel,
    "--no-clean",
    ...forwardedArgs,
  ];
  if (env.OPENCLAW_BUILD_ALL_NO_PNPM === "1") {
    return {
      command: params.nodeExecPath ?? process.execPath,
      args: ["node_modules/tsdown/dist/run.mjs", ...tsdownArgs],
      options: {
        stdio: tsdownStdio(),
        shell: false,
        windowsVerbatimArguments: undefined,
        env,
      },
    };
  }
  const runner = resolvePnpmRunner({
    env,
    pnpmArgs: ["exec", "tsdown", ...tsdownArgs],
    nodeExecPath: params.nodeExecPath ?? process.execPath,
    npmExecPath: params.npmExecPath ?? env.npm_execpath,
    comSpec: params.comSpec,
    platform: (params.platform ?? process.platform) === "win32" ? "win32" : "linux",
  });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      stdio: tsdownStdio(),
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
      env,
    },
  };
}

function selectsMainConfig(args: string[]) {
  const config = readForwardedOption(args, ["--config", "-c"]);
  if (config === undefined) {
    return false;
  }
  const resolvedConfig = path.resolve(config);
  const mainConfig = path.resolve("tsdown.config.ts");
  return resolvedConfig === mainConfig || resolvedConfig === path.dirname(mainConfig);
}

function resolveSerializedMainConfigGroups(filters: string[]) {
  const uniqueFilters = [...new Set(filters)];
  if (filters.length === 0 || filters.includes(".")) {
    return SERIALIZED_MAIN_CONFIG_GROUPS;
  }
  if (
    uniqueFilters.some(
      (filter) => filter !== "." && !SERIALIZED_MAIN_CONFIG_GROUPS.includes(filter),
    )
  ) {
    return null;
  }
  if (filters.includes(TSDOWN_UNIFIED_CONFIG_GROUP) && !filters.some(isUnifiedDtsGroup)) {
    return filters.includes(TSDOWN_PACKAGE_CONFIG_GROUP)
      ? SERIALIZED_MAIN_CONFIG_GROUPS
      : SERIALIZED_MAIN_CONFIG_GROUPS.slice(1);
  }
  if (uniqueFilters.length < 2) {
    return null;
  }
  const selectedFilters = new Set(uniqueFilters);
  return SERIALIZED_MAIN_CONFIG_GROUPS.filter((group) => selectedFilters.has(group));
}

/** Builds declarations in dependency order without overlapping the largest graphs. */
export function resolveTsdownBuildInvocations(params: TsdownBuildParams = {}) {
  const forwardedArgs = params.args ?? [];
  readForwardedScalarOption(forwardedArgs, ["--out-dir", "-d"], "--out-dir/-d");
  if (forwardedArgs.filter(isConfigArg).length > 1) {
    throw new Error("tsdown build accepts only one --config/-c/--no-config selector");
  }
  const env = params.env ?? process.env;
  const forwardedFilters = readForwardedOptions(forwardedArgs, ["--filter", "-F"]);
  const hasForwardedFilter = forwardedArgs.some(isFilterArg);
  const aiArgs = forwardedArgs.filter((arg, index) => {
    const previous = forwardedArgs[index - 1];
    return !isFilterArg(arg) && !isFilterFlag(previous);
  });
  const dtsArg = aiArgs.findLast((arg) => arg === "--dts" || arg === "--no-dts");
  const declarationsEnabled = dtsArg
    ? dtsArg === "--dts"
    : env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1";
  const hasForwardedConfig = aiArgs.some(isConfigArg);

  const declarationEnv =
    declarationsEnabled && env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? { ...env, [RUN_NODE_SKIP_DTS_BUILD_ENV]: "0" }
      : env;

  if (forwardedArgs.some(isWatchArg)) {
    if (!hasForwardedConfig) {
      throw new Error(
        "tsdown build watch mode requires an explicit --config/-c or --no-config selector. Run separate watchers for tsdown.config.ts and tsdown.ai.config.ts to watch both graphs.",
      );
    }
    // Watchers are long-lived, so sequential group orchestration would block forever on the
    // first child. Keep watch mode inside tsdown's single owning process.
    return [resolveTsdownBuildInvocation(params)];
  }

  if (hasForwardedConfig) {
    if (declarationsEnabled && selectsMainConfig(forwardedArgs)) {
      const serializedGroups = resolveSerializedMainConfigGroups(forwardedFilters);
      if (serializedGroups) {
        return serializedGroups.map((group) =>
          resolveTsdownBuildInvocation({
            ...params,
            args: ["--filter", group, ...aiArgs],
            env: declarationEnv,
          }),
        );
      }
    }
    return [resolveTsdownBuildInvocation(params)];
  }

  const invocations = [
    resolveTsdownBuildInvocation({
      ...params,
      args: ["--config", "tsdown.ai.config.ts", ...aiArgs],
    }),
  ];

  const forwardedFilterSet = new Set(forwardedFilters);
  const uniqueForwardedFilters = SERIALIZED_MAIN_CONFIG_GROUPS.filter((group) =>
    forwardedFilterSet.has(group),
  );
  const hasUnknownFilter = forwardedFilters.some(
    (filter) => filter !== "." && !SERIALIZED_MAIN_CONFIG_GROUPS.includes(filter),
  );
  const serializedGroups = forwardedFilters.includes(".")
    ? SERIALIZED_MAIN_CONFIG_GROUPS
    : !hasUnknownFilter && uniqueForwardedFilters.length > 1
      ? uniqueForwardedFilters
      : null;
  if (!declarationsEnabled || (hasForwardedFilter && !serializedGroups)) {
    const mainEnv =
      !declarationsEnabled && env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1"
        ? { ...env, [RUN_NODE_SKIP_DTS_BUILD_ENV]: "1" }
        : env;
    invocations.push(resolveTsdownBuildInvocation({ ...params, env: mainEnv }));
    return invocations;
  }

  for (const group of serializedGroups ?? SERIALIZED_MAIN_CONFIG_GROUPS) {
    invocations.push(
      resolveTsdownBuildInvocation({
        ...params,
        args: ["--filter", group, ...aiArgs],
        env: declarationEnv,
      }),
    );
  }
  return invocations;
}

function isFullTsdownBuildPlan(args: string[]) {
  const filters = readForwardedOptions(args, ["--filter", "-F"]);
  const selectsUnifiedRuntime =
    filters.length === 0 || filters.includes(TSDOWN_UNIFIED_CONFIG_GROUP) || filters.includes(".");
  return selectsUnifiedRuntime && (!args.some(isConfigArg) || selectsMainConfig(args));
}

export function resolveTsdownBuildPlan(params: TsdownBuildParams = {}) {
  const budget = resolveTsdownMemoryBudget(params);
  const maxOldSpaceMb = budget.maxOldSpaceMb;
  const preparedParams = {
    ...params,
    resolvedMaxOldSpaceMb: maxOldSpaceMb,
  };
  return {
    env: resolveTsdownEnv(params.env ?? process.env, preparedParams),
    maxOldSpaceMb,
    heapShortfall:
      budget.unresolvedCgroupMemory || isFullTsdownBuildPlan(params.args ?? [])
        ? describeInsufficientTsdownHeap(preparedParams, budget)
        : null,
    invocations: resolveTsdownBuildInvocations(preparedParams),
  };
}

export function prepareTsdownBuildExecution(
  params: TsdownBuildParams = {},
  hooks: {
    cleanup?: (args: string[]) => void;
    reportShortfall?: (
      shortfall: NonNullable<ReturnType<typeof describeInsufficientTsdownHeap>>,
    ) => void;
  } = {},
) {
  const args = params.args ?? [];
  const plan = resolveTsdownBuildPlan(params);
  if (plan.heapShortfall) {
    hooks.reportShortfall?.(plan.heapShortfall);
    if (plan.heapShortfall.fatal) {
      return null;
    }
  }
  const cleanup =
    hooks.cleanup ??
    ((forwardedArgs: string[]) => {
      const roots = resolveTsdownCleanOutputRoots(forwardedArgs);
      // Reject unsafe custom output roots before any preparatory mutation. The second
      // validation in cleanTsdownOutputRoots closes a symlink race before deletion.
      assertTsdownCleanOutputRoots({ roots });
      pruneUntrackedGeneratedSourceDeclarations();
      pruneStaleRuntimeSymlinks();
      cleanTsdownOutputRoots({ roots });
    });
  cleanup(args);
  return plan;
}

type TaskkillRunner = (
  command: string,
  args: string[],
  options: { killSignal?: NodeJS.Signals; stdio?: StdioOptions; timeout?: number },
) => { error?: Error; status: number | null };

export async function runTsdownBuildInvocation(
  invocation: TsdownBuildInvocation,
  params: {
    stdout?: { write(chunk: unknown): unknown };
    stderr?: { write(chunk: unknown): unknown };
    env?: NodeJS.ProcessEnv;
    scanner?: ReturnType<typeof createTsdownOutputScanner>;
    platform?: NodeJS.Platform;
    runTaskkill?: TaskkillRunner;
  } = {},
): Promise<TsdownBuildResult> {
  const stdout = params.stdout ?? process.stdout;
  const stderr = params.stderr ?? process.stderr;
  const env = params.env ?? process.env;
  const scanner = params.scanner ?? createTsdownOutputScanner();
  const timeoutMs = parsePositiveIntegerEnv(
    env.OPENCLAW_TSDOWN_TIMEOUT_MS,
    "OPENCLAW_TSDOWN_TIMEOUT_MS",
  );
  const heartbeatMs =
    parseNonNegativeIntegerEnv(env.OPENCLAW_TSDOWN_HEARTBEAT_MS, "OPENCLAW_TSDOWN_HEARTBEAT_MS") ??
    DEFAULT_HEARTBEAT_MS;
  let timedOut = false;
  let parentSignal: NodeJS.Signals | undefined;
  let settled = false;
  let lastOutputAt = Date.now();
  let forceKillAt: number | null = null;

  const platform = params.platform ?? process.platform;
  const runTaskkill = params.runTaskkill ?? spawnSync;
  const useProcessGroup = platform !== "win32";
  const [stdin, stdoutPipe, stderrPipe] = invocation.options.stdio;
  if (stdin !== "ignore" || stdoutPipe !== "pipe" || stderrPipe !== "pipe") {
    throw new Error("tsdown invocation stdio must be ignore/pipe/pipe");
  }
  const child = spawn(invocation.command, invocation.args, {
    ...invocation.options,
    stdio: tsdownStdio(),
    detached: useProcessGroup,
  });
  const pidText = child.pid ? ` pid=${child.pid}` : "";

  function markOutput() {
    lastOutputAt = Date.now();
  }

  function signalChild(signal: NodeJS.Signals) {
    terminateManagedChild(child, signal, {
      platform,
      runTaskkill,
      useProcessGroup,
    });
  }

  const parentSignalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  function cleanupParentSignalHandlers() {
    for (const { signal, handler } of parentSignalHandlers) {
      process.off(signal, handler);
    }
    parentSignalHandlers.length = 0;
  }

  function relayParentSignal(signal: NodeJS.Signals) {
    const handler = () => {
      parentSignal ??= signal;
      signalChild(signal);
      signalChild("SIGKILL");
    };
    parentSignalHandlers.push({ signal, handler });
    process.once(signal, handler);
  }

  if (useProcessGroup) {
    relayParentSignal("SIGINT");
    relayParentSignal("SIGTERM");
    relayParentSignal("SIGHUP");
  }

  const processTreeAlive = () =>
    inspectManagedProcessGroup(child, {
      errorPolicy: "alive-on-eperm",
      inspectLeaderWhenNoGroup: true,
      platform,
    }) === "live";
  const waitForProcessTreeExit = (timeoutMsToWait: number) =>
    waitForManagedProcessGroupExit(child, timeoutMsToWait, {
      errorPolicy: "alive-on-eperm",
      inspectLeaderWhenNoGroup: true,
      platform,
    });

  async function finishTimedOutProcessTree() {
    const graceRemainingMs =
      forceKillAt === null ? TERMINATION_GRACE_MS : Math.max(0, forceKillAt - Date.now());
    if (graceRemainingMs > 0) {
      await waitForProcessTreeExit(graceRemainingMs);
    }
    if (processTreeAlive()) {
      signalChild("SIGKILL");
      await waitForProcessTreeExit(POST_FORCE_KILL_WAIT_MS);
    }
  }

  child.stdout?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stderr.write(chunk);
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (settled) {
            return;
          }
          const silentForMs = Date.now() - lastOutputAt;
          if (silentForMs < heartbeatMs) {
            return;
          }
          stderr.write(
            `[tsdown-build] still running${pidText}; no output for ${Math.round(
              silentForMs / 1000,
            )}s\n`,
          );
          lastOutputAt = Date.now();
        }, heartbeatMs).unref()
      : null;

  const timeout =
    timeoutMs !== null
      ? setTimeout(() => {
          timedOut = true;
          stderr.write(`[tsdown-build] timeout after ${timeoutMs}ms${pidText}; sending SIGTERM\n`);
          signalChild("SIGTERM");
          forceKillAt = Date.now() + TERMINATION_GRACE_MS;
          setTimeout(() => {
            if (!settled) {
              stderr.write(`[tsdown-build] forcing SIGKILL${pidText}\n`);
              signalChild("SIGKILL");
            }
          }, TERMINATION_GRACE_MS).unref();
        }, timeoutMs).unref()
      : null;

  return new Promise<TsdownBuildResult>((resolve) => {
    child.once("error", (error) => {
      settled = true;
      cleanupParentSignalHandlers();
      clearInterval(heartbeat ?? undefined);
      clearTimeout(timeout ?? undefined);
      stderr.write(`[tsdown-build] failed to start: ${String(error)}\n`);
      resolve({
        status: 1,
        signal: null,
        timedOut,
        error,
        ...scanner.finish(),
      });
    });
    child.once("close", (status, signal) => {
      let exitStatus = status;
      function finish() {
        settled = true;
        cleanupParentSignalHandlers();
        clearInterval(heartbeat ?? undefined);
        clearTimeout(timeout ?? undefined);
        resolve({
          status: parentSignal ? signalExitCode(parentSignal) : exitStatus,
          signal: parentSignal ?? signal,
          timedOut,
          error: null,
          ...scanner.finish(),
        });
      }

      void (async () => {
        if (timedOut || parentSignal) {
          await finishTimedOutProcessTree();
        } else if (processTreeAlive()) {
          signalChild("SIGKILL");
          await waitForProcessTreeExit(POST_FORCE_KILL_WAIT_MS);
          exitStatus = 1;
        }
        if (processTreeAlive()) {
          // Keep ownership when the group could still mutate output after close.
          throw Object.assign(new Error("tsdown process group did not exit"), {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "live",
          });
        }
        finish();
      })().catch((error: unknown) => {
        settled = true;
        cleanupParentSignalHandlers();
        clearInterval(heartbeat ?? undefined);
        clearTimeout(timeout ?? undefined);
        resolve({
          status: 1,
          signal,
          timedOut,
          error: toErrorObject(error, "tsdown cleanup failed"),
          ...scanner.finish(),
        });
      });
    });
  });
}

/** Execute CLI and staged declaration plans with the same diagnostics and deadlines. */
export async function executeTsdownBuildPlan(
  plan: NonNullable<ReturnType<typeof prepareTsdownBuildExecution>>,
) {
  let result: TsdownBuildResult | undefined;
  for (const [index, invocation] of plan.invocations.entries()) {
    const startedAt = performance.now();
    result = await runTsdownBuildInvocation(invocation);
    if (result.error) {
      throw result.error;
    }
    // Per-invocation timing separates the AI-declarations pass from the main
    // graph in CI logs; the combined step is otherwise a single opaque cost.
    console.log(
      `[tsdown-build] invocation ${index + 1}/${plan.invocations.length} finished in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    if (
      result.timedOut ||
      result.status !== 0 ||
      result.hasIneffectiveDynamicImport ||
      result.fatalUnresolvedImport
    ) {
      break;
    }
  }

  if (!result) {
    return 1;
  }

  if (result.status === 0 && result.hasIneffectiveDynamicImport) {
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    return 1;
  }

  if (result.status === 0 && result.fatalUnresolvedImport) {
    console.error(
      `Build emitted [UNRESOLVED_IMPORT] outside extensions: ${result.fatalUnresolvedImport}`,
    );
    return 1;
  }

  if (result.timedOut) {
    return 124;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return 1;
}

export async function runTsdownBuild(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseTsdownBuildArgs(argv);
  if (args.help) {
    console.log(tsdownBuildUsage());
    return 0;
  }
  const plan = prepareTsdownBuildExecution(
    { args: args.forwardedArgs },
    {
      reportShortfall(shortfall) {
        if (shortfall.fatal) {
          console.error(shortfall.message);
        } else {
          console.warn(shortfall.message);
        }
      },
    },
  );
  if (!plan) {
    return 1;
  }
  return executeTsdownBuildPlan(plan);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  process.exitCode = parseTsdownBuildArgs(argv).help
    ? await runTsdownBuild(argv)
    : await withDistArtifactOwnership(process.cwd(), () => runTsdownBuild(argv));
}
