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
import { pathToFileURL } from "node:url";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./lib/managed-child-process.mts";
import { decodeMountInfoPath } from "./lib/mountinfo-path.mjs";
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
import {
  isSourceCheckoutRoot,
  pruneBundledPluginSourceNodeModules,
} from "./postinstall-bundled-plugins.mjs";

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
const TSDOWN_CGROUP_MEMORY_HEADROOM_MB = 768;
const DEFAULT_CGROUP_V2_MOUNT_PATH = "/sys/fs/cgroup";
const DEFAULT_CGROUP_V1_MEMORY_MOUNT_PATH = "/sys/fs/cgroup/memory";
const PROC_SELF_CGROUP_PATH = "/proc/self/cgroup";
const PROC_SELF_MOUNTINFO_PATH = "/proc/self/mountinfo";
const SERIALIZED_MAIN_CONFIG_GROUPS = [
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
];
// The v2 high and v1 soft limits throttle reclaim rather than failing allocation, so a heap
// sized above either stalls the build instead of OOM-ing; both kinds still cap the build heap.
const CGROUP_V2_MEMORY_LIMIT_FILES = ["memory.max", "memory.high"];
const CGROUP_V1_MEMORY_LIMIT_FILES = ["memory.limit_in_bytes", "memory.soft_limit_in_bytes"];
const PROC_MEMINFO_PATH = "/proc/meminfo";
const tsdownStdio = () => ["ignore", "pipe", "pipe"] satisfies ["ignore", "pipe", "pipe"];
// Build descendants get a short cleanup window; a timed-out build must not hold CI for seconds.
const TERMINATION_GRACE_MS = 250;
const POST_FORCE_KILL_WAIT_MS = 250;
const ROOT_TSDOWN_OUTPUT_ROOTS = ["dist", "dist-runtime"];
const PRESERVED_TSDOWN_OUTPUT_FILES = ["dist/cli-startup-metadata.json"];
const PRESERVE_CLI_STARTUP_METADATA_ENV = "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA";
const GENERATED_SOURCE_DECLARATION_PATHSPEC = ":(glob)extensions/**/*.d.ts";
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const SOURCE_DECLARATION_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";

type OutputRootParams = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  roots?: string[];
};

export type MemoryLimitParams = {
  cgroupMemoryLimitBytes?: number;
  cgroupMemoryLimitPaths?: string[];
  constrainedMemoryBytes?: number;
  env?: NodeJS.ProcessEnv;
  fs?: { readFileSync(filePath: string, encoding: "utf8"): string };
  physicalMemoryBytes?: number;
  platform?: string;
  procMeminfoPath?: string;
  procMemTotalBytes?: number;
  procSelfCgroupPath?: string;
  procSelfMountinfoPath?: string;
  resolvedMaxOldSpaceMb?: number;
};

type CgroupMount = { mountPoint: string; root: string };

type TsdownBuildParams = MemoryLimitParams & {
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
export function cleanTsdownOutputRoots(params: OutputRootParams = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const env = params.env ?? process.env;
  const roots = params.roots ?? listTsdownOutputRoots();
  const rootPaths = roots.map((root) => path.join(cwd, root));
  // Validate the complete mutation set before traversing protected children or
  // cleaning any earlier root; otherwise a later symlink can leave a partial build.
  for (const rootPath of rootPaths) {
    assertRealOutputRoot(rootPath, { fs: fsImpl });
  }
  const protectedDeclarationPaths =
    env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? listExistingDeclarationOutputPaths(cwd, fsImpl, roots)
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
      // Keep best-effort semantics; protected declaration children can keep a directory non-empty.
    }
  }
}

function listExistingDeclarationOutputPaths(cwd: string, fsImpl: typeof fs, roots: string[]) {
  const protectedPaths = new Set<string>();
  for (const root of roots) {
    collectDeclarationOutputPaths(path.join(cwd, root), protectedPaths, fsImpl);
  }
  return protectedPaths;
}

function listExistingPreservedOutputPaths(cwd: string, env: NodeJS.ProcessEnv, fsImpl: typeof fs) {
  const protectedPaths = new Set<string>();
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
    } else if (DECLARATION_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
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

function readForwardedOption(args: string[], names: string[]) {
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) {
        return args[index + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return undefined;
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
const isUnifiedDtsGroup = (value: string | undefined) =>
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.some((group) => group === value);

/** Limits cleanup to the output roots owned by an explicitly filtered build. */
export function resolveTsdownCleanOutputRoots(args: string[] = []) {
  const config = readForwardedOption(args, ["--config", "-c"]);
  const filter = readForwardedOption(args, ["--filter", "-F"]);
  const configPath = config ? path.resolve(config) : undefined;
  const aiConfigPath = path.resolve("tsdown.ai.config.ts");
  const mainConfigPath = path.resolve("tsdown.config.ts");
  const aiRoot = tsdownPackageOutputRoot("ai");
  const packageRoots = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter((root) => root !== aiRoot);

  if (configPath === aiConfigPath) {
    return [aiRoot];
  }
  if (configPath === mainConfigPath) {
    if (filter === TSDOWN_PACKAGE_CONFIG_GROUP) {
      return packageRoots;
    }
    if (filter === TSDOWN_UNIFIED_CONFIG_GROUP || isUnifiedDtsGroup(filter)) {
      return [...ROOT_TSDOWN_OUTPUT_ROOTS];
    }
    return [...ROOT_TSDOWN_OUTPUT_ROOTS, ...packageRoots];
  }
  if (!config && filter === TSDOWN_PACKAGE_CONFIG_GROUP) {
    return [aiRoot, ...packageRoots];
  }
  if (!config && (filter === TSDOWN_UNIFIED_CONFIG_GROUP || isUnifiedDtsGroup(filter))) {
    return [aiRoot, ...ROOT_TSDOWN_OUTPUT_ROOTS];
  }
  return listTsdownOutputRoots();
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

export function pruneSourceCheckoutBundledPluginNodeModules(
  params: { cwd?: string; logger?: Pick<Console, "warn"> } = {},
) {
  const cwd = params.cwd ?? process.cwd();
  const logger = params.logger ?? console;
  if (!isSourceCheckoutRoot({ packageRoot: cwd, existsSync: fs.existsSync })) {
    return;
  }
  try {
    pruneBundledPluginSourceNodeModules({
      extensionsDir: path.join(cwd, "extensions"),
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      rmSync: fs.rmSync,
    });
  } catch (error) {
    logger.warn(`tsdown: could not prune bundled plugin source node_modules: ${String(error)}`);
  }
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

// Controller mount points are host layout, not constants: v1 controllers may be co-mounted at
// the cgroup root instead of a per-controller directory. Read them where the kernel records
// them so a slice budget is never missed because a path was assumed.
function resolveCgroupMountPoints(params: MemoryLimitParams = {}) {
  const fsImpl = params.fs ?? fs;
  let rawMountinfo = "";
  try {
    rawMountinfo = fsImpl.readFileSync(
      params.procSelfMountinfoPath ?? PROC_SELF_MOUNTINFO_PATH,
      "utf8",
    );
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
      unified.push({ mountPoint, root });
    } else if (fsType === "cgroup" && (superOptions ?? "").split(",").includes("memory")) {
      v1Memory.push({ mountPoint, root });
    }
  }
  return {
    unified:
      unified.length > 0 ? unified : [{ mountPoint: DEFAULT_CGROUP_V2_MOUNT_PATH, root: "/" }],
    v1Memory:
      v1Memory.length > 0
        ? v1Memory
        : [{ mountPoint: DEFAULT_CGROUP_V1_MEMORY_MOUNT_PATH, root: "/" }],
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
    // cgroup_namespaces(7): an inherited mount rooted at /.. exposes a real ancestor of
    // the namespace root. Its root limit still constrains this process even when the hidden
    // leaf name cannot be reconstructed.
    return "/";
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
  try {
    rawCgroup = fsImpl.readFileSync(params.procSelfCgroupPath ?? PROC_SELF_CGROUP_PATH, "utf8");
  } catch {
    // Unreadable off Linux; the hierarchy roots below still apply.
  }

  const paths: string[] = [];
  const addHierarchy = (
    mounts: CgroupMount[],
    limitFiles: string[],
    cgroupPath: string,
    hierarchyFile?: string,
  ) => {
    for (const mount of mounts) {
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
            if (fsImpl.readFileSync(hierarchyPath, "utf8").trim() !== "1") {
              continue;
            }
          } catch {
            continue;
          }
        }
        for (const limitFile of limitFiles) {
          paths.push(path.join(mount.mountPoint, ...segments.slice(0, depth), limitFile));
        }
      }
    }
  };

  const mounts = resolveCgroupMountPoints(params);
  let sawMemoryRecord = false;
  for (const line of rawCgroup.split("\n")) {
    const record = /^\d+:([^:]*):(.*)$/u.exec(line);
    if (!record) {
      continue;
    }
    const controllers = record[1] ?? "";
    if (controllers === "") {
      sawMemoryRecord = true;
      addHierarchy(mounts.unified, CGROUP_V2_MEMORY_LIMIT_FILES, record[2] ?? "");
    } else if (controllers.split(",").includes("memory")) {
      sawMemoryRecord = true;
      addHierarchy(
        mounts.v1Memory,
        CGROUP_V1_MEMORY_LIMIT_FILES,
        record[2] ?? "",
        "memory.use_hierarchy",
      );
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
  return paths;
}

function readCgroupMemoryLimitBytes(params: MemoryLimitParams = {}) {
  const configuredLimit = params.cgroupMemoryLimitBytes;
  if (configuredLimit !== undefined && Number.isFinite(configuredLimit) && configuredLimit >= 0) {
    return Math.trunc(configuredLimit);
  }

  const fsImpl = params.fs ?? fs;
  const paths = params.cgroupMemoryLimitPaths ?? resolveCgroupMemoryLimitPaths(params);
  // Supported Node versions expose libuv's canonical cgroup v1/v2 result. Keep it as an
  // authoritative candidate while the custom walk adds nonstandard mounts and ancestor caps.
  const constrainedMemoryBytes =
    params.constrainedMemoryBytes ?? (params.fs === undefined ? process.constrainedMemory() : 0);
  // An ancestor may bound the leaf, so the tightest limit in the chain wins.
  let tightestLimitBytes =
    Number.isFinite(constrainedMemoryBytes) && constrainedMemoryBytes > 0
      ? Math.trunc(constrainedMemoryBytes)
      : null;
  for (const limitPath of paths) {
    try {
      const limitBytes = parseCgroupMemoryLimitBytes(fsImpl.readFileSync(limitPath, "utf8"));
      if (limitBytes !== null && (tightestLimitBytes === null || limitBytes < tightestLimitBytes)) {
        tightestLimitBytes = limitBytes;
      }
    } catch {
      // Missing cgroup files are expected outside Linux containers.
    }
  }

  return tightestLimitBytes;
}

function parseProcMemTotalBytes(value: string) {
  const match = value.match(/^MemTotal:\s+(\d+)\s+kB$/imu);
  const kibibytes = match?.[1];
  if (!kibibytes) {
    return null;
  }
  const parsed = BigInt(kibibytes) * 1024n;
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
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
    return parseProcMemTotalBytes(
      fsImpl.readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
    );
  } catch {
    return null;
  }
}

function readPhysicalMemoryTotalBytes(params: MemoryLimitParams = {}) {
  const totalBytes = params.physicalMemoryBytes ?? os.totalmem();
  return Number.isFinite(totalBytes) && totalBytes > 0 ? Math.trunc(totalBytes) : null;
}

function resolveTsdownMaxOldSpaceMb(params: MemoryLimitParams = {}) {
  if (params.resolvedMaxOldSpaceMb !== undefined) {
    return params.resolvedMaxOldSpaceMb;
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
    return envOverride;
  }

  const cgroupLimitBytes = readCgroupMemoryLimitBytes(params);
  const physicalLimitBytes = readProcMemTotalBytes(params) ?? readPhysicalMemoryTotalBytes(params);
  const limitBytes =
    cgroupLimitBytes === null || physicalLimitBytes === null
      ? (cgroupLimitBytes ?? physicalLimitBytes)
      : Math.min(cgroupLimitBytes, physicalLimitBytes);
  if (limitBytes === null) {
    return defaultMaxOldSpaceMb;
  }

  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  // Never exceed the budget just discovered: a floor applied on top of a real limit produces
  // a heap the cgroup cannot honour, which is an OOM kill rather than a smaller build.
  const cgroupCap = Math.max(1, limitMb - TSDOWN_CGROUP_MEMORY_HEADROOM_MB);
  return Math.min(defaultMaxOldSpaceMb, cgroupCap);
}

/**
 * Measured against this repo by running the full eleven-invocation build inside real cgroups.
 * A 5GiB slice resolves this heap, completes, and peaks at 4730MiB. A 4GiB slice (3328MB heap)
 * and a 2816MiB slice (2048MB heap) are both killed in the third, unified-runtime invocation,
 * which also runs when declarations are disabled. Roughly 380MiB of the peak is rolldown, a
 * native addon which --max-old-space-size does not govern at all.
 */
const MEASURED_MIN_TSDOWN_HEAP_MB = 4352;
const TSDOWN_ALLOW_SMALL_HEAP_ENV = "OPENCLAW_TSDOWN_ALLOW_SMALL_HEAP";

/**
 * Describes a host that cannot fit the build, or null when it can. Reported before any
 * output is cleaned: a host that cannot rebuild must not also lose the build it already
 * has. Fatal by default because continuing either aborts partway through the invocation
 * list or, when the heap outruns a container limit, thrashes at the ceiling instead of
 * failing, which starves every other process on the machine.
 */
export function describeInsufficientTsdownHeap(params: MemoryLimitParams = {}) {
  const maxOldSpaceMb = resolveTsdownMaxOldSpaceMb(params);
  if (maxOldSpaceMb >= MEASURED_MIN_TSDOWN_HEAP_MB) {
    return null;
  }
  const env = params.env ?? process.env;
  const explicitHeapMb = parsePositiveIntegerEnv(
    env[TSDOWN_MAX_OLD_SPACE_MB_ENV],
    TSDOWN_MAX_OLD_SPACE_MB_ENV,
  );
  const fatal = explicitHeapMb === null && env[TSDOWN_ALLOW_SMALL_HEAP_ENV] !== "1";
  const outcome = fatal
    ? [
        "Stopping before any build output is removed. Pick one:",
        "  - give this machine or container more memory",
        `  - set ${TSDOWN_ALLOW_SMALL_HEAP_ENV}=1 to attempt the build anyway`,
      ]
    : [
        `Continuing because ${explicitHeapMb === null ? `${TSDOWN_ALLOW_SMALL_HEAP_ENV}=1 permits a smaller heap` : `${TSDOWN_MAX_OLD_SPACE_MB_ENV} explicitly requests ${explicitHeapMb}MB`}. Existing build output will now be cleaned; the build may stall or fail.`,
      ];
  return {
    fatal,
    message: [
      `[tsdown-build] The resolved OpenClaw build heap is ${maxOldSpaceMb}MB, ` +
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

function normalizeTsdownNodeOptions(nodeOptions: string, params: MemoryLimitParams = {}) {
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
  params: MemoryLimitParams = {},
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
  const forwardedArgs = params.args ?? [];
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
  return config !== undefined && path.resolve(config) === path.resolve("tsdown.config.ts");
}

/** Builds declarations in dependency order without overlapping the largest graphs. */
export function resolveTsdownBuildInvocations(params: TsdownBuildParams = {}) {
  const forwardedArgs = params.args ?? [];
  const env = params.env ?? process.env;
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

  if (hasForwardedConfig) {
    if (declarationsEnabled && selectsMainConfig(forwardedArgs)) {
      const filter = readForwardedOption(forwardedArgs, ["--filter", "-F"]);
      const firstGroupIndex =
        filter === undefined ? 0 : filter === TSDOWN_UNIFIED_CONFIG_GROUP ? 1 : -1;
      if (firstGroupIndex >= 0) {
        return SERIALIZED_MAIN_CONFIG_GROUPS.slice(firstGroupIndex).map((group) =>
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

  if (!declarationsEnabled || hasForwardedFilter) {
    const mainEnv =
      !declarationsEnabled && env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1"
        ? { ...env, [RUN_NODE_SKIP_DTS_BUILD_ENV]: "1" }
        : env;
    invocations.push(resolveTsdownBuildInvocation({ ...params, env: mainEnv }));
    return invocations;
  }

  for (const group of SERIALIZED_MAIN_CONFIG_GROUPS) {
    invocations.push(
      resolveTsdownBuildInvocation({
        ...params,
        args: ["--filter", group, ...forwardedArgs],
        env: declarationEnv,
      }),
    );
  }
  return invocations;
}

function isFullTsdownBuildPlan(args: string[]) {
  const filter = readForwardedOption(args, ["--filter", "-F"]);
  const selectsCompleteMainConfig =
    selectsMainConfig(args) && (filter === undefined || filter === TSDOWN_UNIFIED_CONFIG_GROUP);
  return (!args.some(isConfigArg) && !args.some(isFilterArg)) || selectsCompleteMainConfig;
}

export function resolveTsdownBuildPlan(params: TsdownBuildParams = {}) {
  const maxOldSpaceMb = resolveTsdownMaxOldSpaceMb(params);
  const preparedParams = {
    ...params,
    resolvedMaxOldSpaceMb: maxOldSpaceMb,
  };
  return {
    maxOldSpaceMb,
    heapShortfall: isFullTsdownBuildPlan(params.args ?? [])
      ? describeInsufficientTsdownHeap(preparedParams)
      : null,
    invocations: resolveTsdownBuildInvocations(preparedParams),
  };
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
      signalChild(signal);
      signalChild("SIGKILL");
      cleanupParentSignalHandlers();
      process.kill(process.pid, signal);
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
      function finish() {
        settled = true;
        cleanupParentSignalHandlers();
        clearInterval(heartbeat ?? undefined);
        clearTimeout(timeout ?? undefined);
        resolve({
          status,
          signal,
          timedOut,
          error: null,
          ...scanner.finish(),
        });
      }

      if (timedOut) {
        void finishTimedOutProcessTree().then(finish, finish);
        return;
      }

      finish();
    });
  });
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  const args = parseTsdownBuildArgs(process.argv.slice(2));
  if (args.help) {
    console.log(tsdownBuildUsage());
    process.exit(0);
  }
  const plan = resolveTsdownBuildPlan({ args: args.forwardedArgs });
  const heapShortfall = plan.heapShortfall;
  if (heapShortfall) {
    if (heapShortfall.fatal) {
      console.error(heapShortfall.message);
      process.exit(1);
    }
    console.warn(heapShortfall.message);
  }
  pruneSourceCheckoutBundledPluginNodeModules();
  pruneUntrackedGeneratedSourceDeclarations();
  pruneStaleRuntimeSymlinks();
  cleanTsdownOutputRoots({ roots: resolveTsdownCleanOutputRoots(args.forwardedArgs) });
  let result: TsdownBuildResult | undefined;
  for (const [index, invocation] of plan.invocations.entries()) {
    const startedAt = performance.now();
    result = await runTsdownBuildInvocation(invocation);
    // Per-invocation timing separates the AI-declarations pass from the main
    // graph in CI logs; the combined step is otherwise a single opaque cost.
    console.log(
      `[tsdown-build] invocation ${index + 1}/${plan.invocations.length} finished in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    if (result.status !== 0 || result.hasIneffectiveDynamicImport || result.fatalUnresolvedImport) {
      break;
    }
  }

  if (!result) {
    process.exit(1);
  }

  if (result.status === 0 && result.hasIneffectiveDynamicImport) {
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    process.exit(1);
  }

  if (result.status === 0 && result.fatalUnresolvedImport) {
    console.error(
      `Build emitted [UNRESOLVED_IMPORT] outside extensions: ${result.fatalUnresolvedImport}`,
    );
    process.exit(1);
  }

  if (result.timedOut) {
    process.exit(124);
  }

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}
