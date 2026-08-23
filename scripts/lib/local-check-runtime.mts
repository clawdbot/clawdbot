// Applies local resource policy for expensive check commands.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GIB = 1024 ** 3;
const DEFAULT_LOCAL_GO_GC = "30";
const DEFAULT_LOCAL_GO_MAX_PROCS = 2;
const DEFAULT_LOCAL_GO_MEMORY_LIMIT = "3GiB";
const DEFAULT_LOCAL_TSGO_BUILD_INFO_FILE = ".artifacts/tsgo-cache/root.tsbuildinfo";
const DEFAULT_FAST_LOCAL_CHECK_MIN_MEMORY_BYTES = 48 * GIB;
const DEFAULT_FAST_LOCAL_CHECK_MIN_CPUS = 12;

type Env = NodeJS.ProcessEnv;
type Resources = {
  logicalCpuCount: number;
  totalMemoryBytes: number;
};

type LocalCheckMode = "auto" | "full" | "throttled";
type RepoToolOptions = {
  cwd?: string;
  fileExists?: (candidate: string) => boolean;
  resolveCommonDir?: (cwd: string) => string | null;
};

/** Return whether local check safeguards are enabled for an environment. */
export function isLocalCheckEnabled(env: Env) {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

function isCiLikeEnv(env: Env = process.env) {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

/** Ensure local check runs opt into safeguard environment outside CI. */
export function resolveLocalCheckEnv(env: Env = process.env) {
  if (isCiLikeEnv(env) || isLocalCheckEnabled(env)) {
    return env;
  }

  return {
    ...env,
    OPENCLAW_LOCAL_CHECK: "1",
  };
}

/** Resolve a repo tool from this worktree or the primary checkout's installed toolchain. */
export function resolveRepoToolBinPath(
  toolName: string,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    resolveCommonDir = resolveGitCommonDir,
  }: RepoToolOptions = {},
) {
  const localPath = path.resolve(cwd, "node_modules", ".bin", toolName);
  if (fileExists(localPath)) {
    return localPath;
  }

  const commonDir = resolveCommonDir(cwd);
  if (!commonDir || path.basename(commonDir) !== ".git") {
    return localPath;
  }

  // Linked worktrees share the primary checkout's .git directory. Its parent
  // owns the installed toolchain that dependency-less worktrees can reuse.
  const primaryPath = path.join(path.dirname(commonDir), "node_modules", ".bin", toolName);
  return fileExists(primaryPath) ? primaryPath : localPath;
}

/** Link a dependency-less worktree to the primary checkout toolchain selected above. */
export function ensureRepoToolNodeModulesLink(
  toolPath: string,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    resolveCommonDir = resolveGitCommonDir,
    symlink = fs.symlinkSync,
    platform = process.platform,
  }: RepoToolOptions & {
    symlink?: typeof fs.symlinkSync;
    platform?: NodeJS.Platform;
  } = {},
) {
  const localNodeModules = path.resolve(cwd, "node_modules");
  if (fileExists(localNodeModules)) {
    return localNodeModules;
  }

  const commonDir = resolveCommonDir(cwd);
  if (!commonDir || path.basename(commonDir) !== ".git") {
    return null;
  }

  const primaryNodeModules = path.join(path.dirname(commonDir), "node_modules");
  const toolNodeModules = path.dirname(path.dirname(path.resolve(toolPath)));
  if (toolNodeModules !== path.resolve(primaryNodeModules) || !fileExists(primaryNodeModules)) {
    return null;
  }

  try {
    // Match run-vitest.mjs's hydrated-toolchain behavior: keep one stable link
    // so compilers can resolve imports from worktree source paths.
    symlink(primaryNodeModules, localNodeModules, platform === "win32" ? "junction" : "dir");
  } catch (error) {
    // Another local runner may have installed the same stable link concurrently.
    if (!fileExists(localNodeModules)) {
      throw error;
    }
  }
  return localNodeModules;
}

function hasFlag(args: string[], name: string) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function hasOxlintFormatArg(args: string[]) {
  return args.some(
    (arg) =>
      arg === "--format" ||
      arg.startsWith("--format=") ||
      arg === "-f" ||
      arg.startsWith("-f=") ||
      (arg.startsWith("-f") && arg.length > 2),
  );
}

/** Apply the shared memory and scheduler limits for Go-backed check helpers. */
function applyThrottledGoRuntimeEnv(env: Env, hostResources: Resources) {
  if (!env.GOMAXPROCS) {
    env.GOMAXPROCS = String(
      Math.min(DEFAULT_LOCAL_GO_MAX_PROCS, Math.max(1, hostResources.logicalCpuCount)),
    );
  }
  if (!env.GOGC) {
    env.GOGC = DEFAULT_LOCAL_GO_GC;
  }
  if (!env.GOMEMLIMIT) {
    env.GOMEMLIMIT = DEFAULT_LOCAL_GO_MEMORY_LIMIT;
  }
}

/** Apply local tsgo defaults for declaration skipping, caching, throttling, and profiling. */
export function applyLocalTsgoPolicy(args: string[], env: Env, hostResources: Resources) {
  const nextEnv = { ...env };
  const nextArgs = [...args];
  const defaultProjectRun = nextArgs.length === 0;

  if (!hasFlag(nextArgs, "--declaration") && !nextArgs.includes("-d")) {
    insertBeforeSeparator(nextArgs, "--declaration", "false");
  }

  if (!isLocalCheckEnabled(nextEnv)) {
    return { env: nextEnv, args: nextArgs };
  }

  if (defaultProjectRun) {
    insertBeforeSeparator(nextArgs, "--incremental");
    insertBeforeSeparator(
      nextArgs,
      "--tsBuildInfoFile",
      nextEnv.OPENCLAW_TSGO_BUILD_INFO_FILE ?? DEFAULT_LOCAL_TSGO_BUILD_INFO_FILE,
    );
  }

  const resolvedHostResources = resolveHostResources(hostResources);
  if (shouldThrottleLocalChecks(nextEnv, resolvedHostResources, "auto")) {
    insertBeforeSeparator(nextArgs, "--singleThreaded");
    insertBeforeSeparator(nextArgs, "--checkers", "1");
    applyThrottledGoRuntimeEnv(nextEnv, resolvedHostResources);
  }
  if (nextEnv.OPENCLAW_TSGO_PPROF_DIR && !hasFlag(nextArgs, "--pprofDir")) {
    insertBeforeSeparator(nextArgs, "--pprofDir", nextEnv.OPENCLAW_TSGO_PPROF_DIR);
  }

  return { env: nextEnv, args: nextArgs };
}

/** Apply local oxlint defaults for type-aware checking and throttled worker settings. */
export function applyLocalOxlintPolicy(args: string[], env: Env, hostResources: Resources) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  insertBeforeSeparator(nextArgs, "--type-aware");
  insertBeforeSeparator(nextArgs, "--tsconfig", "config/tsconfig/oxlint.json");
  if (
    !hasFlag(nextArgs, "--report-unused-disable-directives") &&
    !hasFlag(nextArgs, "--report-unused-disable-directives-severity")
  ) {
    insertBeforeSeparator(nextArgs, "--report-unused-disable-directives-severity", "error");
  }
  if (nextEnv.GITHUB_ACTIONS === "true" && !hasOxlintFormatArg(nextArgs)) {
    insertBeforeSeparator(nextArgs, "--format", "stylish");
  }

  if (shouldThrottleLocalChecks(nextEnv, hostResources)) {
    if (!hasFlag(nextArgs, "--threads")) {
      insertBeforeSeparator(nextArgs, "--threads=1");
    }
    // Oxlint's thread flag does not govern the Go tsgolint helper.
    applyThrottledGoRuntimeEnv(nextEnv, hostResources);
  }

  return { env: nextEnv, args: nextArgs };
}

function shouldThrottleLocalChecks(
  env: Env,
  hostResources: Resources | undefined,
  defaultMode: LocalCheckMode = "throttled",
) {
  if (!isLocalCheckEnabled(env)) {
    return false;
  }

  const mode = readLocalCheckMode(env, defaultMode);
  if (mode === "throttled") {
    return true;
  }
  if (mode === "full") {
    return false;
  }

  const resolvedHostResources = resolveHostResources(hostResources);
  return (
    resolvedHostResources.totalMemoryBytes < DEFAULT_FAST_LOCAL_CHECK_MIN_MEMORY_BYTES ||
    resolvedHostResources.logicalCpuCount < DEFAULT_FAST_LOCAL_CHECK_MIN_CPUS
  );
}

function resolveGitCommonDir(cwd: string) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) {
    const raw = result.stdout.trim();
    if (raw.length > 0) {
      return path.resolve(cwd, raw);
    }
  }

  return path.join(cwd, ".git");
}

function insertBeforeSeparator(args: string[], ...items: [string, ...string[]]) {
  if (hasFlag(args, items[0])) {
    return;
  }

  const separatorIndex = args.indexOf("--");
  const insertIndex = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(insertIndex, 0, ...items);
}

function readLocalCheckMode(env: Env, defaultMode: LocalCheckMode) {
  const raw = env.OPENCLAW_LOCAL_CHECK_MODE?.trim().toLowerCase();
  if (raw === "throttled" || raw === "low-memory") {
    return "throttled";
  }
  if (raw === "full" || raw === "fast") {
    return "full";
  }
  return defaultMode;
}

function resolveHostResources(hostResources: Resources | undefined) {
  if (hostResources) {
    return hostResources;
  }

  return {
    totalMemoryBytes: os.totalmem(),
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  };
}
