// Splits oxlint into resource-aware shards with heartbeat and timeout handling.
import { spawn, type ChildProcess } from "node:child_process";
import fs, { type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import {
  ensureRepoToolNodeModulesLink,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import {
  inspectManagedProcessGroup,
  runManagedCommand,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./lib/managed-child-process.mts";
import { shouldPrepareExtensionPackageBoundaryArtifacts } from "./run-oxlint.mts";

const DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE = 8;
const DEFAULT_SHARD_HEARTBEAT_MS = 30_000;
const DEFAULT_SHARD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SHARD_KILL_GRACE_MS = 5_000;
const POST_FORCE_KILL_WAIT_MS = 1_000;
const DEFAULT_SPLIT_CORE_SHARD_CONCURRENCY = 4;
const FAST_LOCAL_CHECK_MIN_CPUS = 12;
const FAST_LOCAL_CHECK_MIN_MEMORY_BYTES = 48 * 1024 ** 3;
// CI runners are dedicated: Blacksmith's 16 vCPU class carries 32GB, which the
// local-Mac threshold above misreads as too small and forces serial shards.
// Three concurrent oxlint shards peak well under 24GB.
const CI_PARALLEL_MIN_CPUS = 8;
const CI_PARALLEL_MIN_MEMORY_BYTES = 24 * 1024 ** 3;
const EXTENSION_TS_CONFIG = "config/tsconfig/oxlint.extensions.json";
const EXTENSIONS_DIR = "extensions";
const OXLINT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const PARENT_TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[];

type OxlintShard = { name: string; args: string[] };
type CoreStripe = { index: number; total: number };
type HostResources = { logicalCpuCount: number; totalMemoryBytes: number };
type ReadDirectoryEntries = (target: string, options: { withFileTypes: true }) => Dirent[];
type DirectoryOptions = { cwd?: string; readDir?: ReadDirectoryEntries };
type DirectoryLookup = Required<DirectoryOptions>;
type ShardOptions = DirectoryOptions & { env?: NodeJS.ProcessEnv };
type PlatformOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };
type PlatformShardOptions = ShardOptions & PlatformOptions & { splitCore?: boolean };
type ResourceOptions = PlatformOptions & { hostResources?: HostResources };
type RunnerOptions = {
  env: NodeJS.ProcessEnv;
  extraArgs: string[];
  runner: string;
};
type ShardRunnerOptions = RunnerOptions & { shard: OxlintShard };
type ShardBatchOptions = RunnerOptions & { concurrency: number; entries: OxlintShard[] };
type ActiveShardChild = { child: ChildProcess; killGraceMs: number };

const ACTIVE_SHARD_CHILDREN = new Set<ActiveShardChild>();
let parentTerminationSignal: (typeof PARENT_TERMINATION_SIGNALS)[number] | null = null;
let parentTerminationForceKill: ReturnType<typeof setTimeout> | null = null;
let parentSignalForwardingInstalled = false;

const CORE_SHARD = {
  name: "core",
  args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
};
const CORE_TS_CONFIG = "config/tsconfig/oxlint.core.json";
const CORE_SPLIT_TARGETS = ["ui", "packages"];
const EXTENSIONS_SHARD = {
  name: "extensions",
  args: ["--tsconfig", EXTENSION_TS_CONFIG, EXTENSIONS_DIR],
};
const SCRIPTS_SHARD = {
  name: "scripts",
  args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
};

/**
 * Builds the platform-specific oxlint shard list.
 */
export function createOxlintShards({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  readDir = fs.readdirSync,
  splitCore = false,
}: PlatformShardOptions = {}) {
  const coreShards = splitCore ? createCoreOxlintShards({ cwd, readDir }) : [CORE_SHARD];
  const extensionShards =
    platform === "win32" ? createWindowsExtensionShards({ cwd, env, readDir }) : [EXTENSIONS_SHARD];

  return [...coreShards, ...extensionShards, SCRIPTS_SHARD];
}

/**
 * Splits core oxlint targets into smaller source/package/UI shards.
 */
function createCoreOxlintShards({
  cwd = process.cwd(),
  readDir = fs.readdirSync,
}: DirectoryOptions = {}) {
  const sourceShards = listSourceRootTargetGroups({ cwd, readDir }).map((targets) => ({
    name: targets.length === 1 ? `core:${targets.join("").replaceAll("/", ":")}` : "core:src:root",
    args: ["--tsconfig", CORE_TS_CONFIG, ...targets],
  }));
  const sourceEntries = sourceShards.length > 0 ? sourceShards : [createCoreShard("src")];

  return [...sourceEntries, ...CORE_SPLIT_TARGETS.map((target) => createCoreShard(target))];
}

function createCoreShard(target: string) {
  return {
    name: `core:${target}`,
    args: ["--tsconfig", CORE_TS_CONFIG, target],
  };
}

/**
 * Chunks extension lint targets to avoid Windows command-line and memory limits.
 */
export function createWindowsExtensionShards({
  cwd = process.cwd(),
  env = process.env,
  readDir = fs.readdirSync,
}: ShardOptions = {}) {
  const entries = listExtensionEntries({ cwd, readDir });
  if (entries.dirs.length === 0 && entries.rootFiles.length === 0) {
    return [EXTENSIONS_SHARD];
  }

  const chunkSize = resolveWindowsExtensionChunkSize(env);
  const shards: OxlintShard[] = [];

  if (entries.rootFiles.length > 0) {
    shards.push({
      name: "extensions:root",
      args: ["--tsconfig", EXTENSION_TS_CONFIG, ...entries.rootFiles],
    });
  }

  for (let index = 0; index < entries.dirs.length; index += chunkSize) {
    const chunk = entries.dirs.slice(index, index + chunkSize);
    const chunkNumber = String(index / chunkSize + 1).padStart(2, "0");
    shards.push({
      name: `extensions:${chunkNumber}`,
      args: ["--tsconfig", EXTENSION_TS_CONFIG, ...chunk],
    });
  }
  return shards;
}

/**
 * Reads the Windows extension shard chunk size.
 */
export function resolveWindowsExtensionChunkSize(env: NodeJS.ProcessEnv = process.env) {
  return resolvePositiveEnvIntWithFallback(
    env,
    "OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE",
    DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE,
  );
}

/**
 * Chooses serial shard execution for constrained hosts or Windows.
 */
export function shouldRunOxlintShardsSerial({
  env = process.env,
  platform = process.platform,
  hostResources,
}: ResourceOptions = {}) {
  const explicitMode = env.OPENCLAW_OXLINT_SHARDS_SERIAL?.trim();
  if (explicitMode === "1") {
    return true;
  }
  if (platform === "win32") {
    return true;
  }
  if (explicitMode === "0") {
    return false;
  }
  const localCheckMode = env.OPENCLAW_LOCAL_CHECK_MODE?.trim().toLowerCase();
  if (!isRemoteChangedGateEnv(env)) {
    if (localCheckMode === "full" || localCheckMode === "fast") {
      return false;
    }
    if (localCheckMode === "throttled" || localCheckMode === "low-memory") {
      return true;
    }
  }
  const resources = resolveHostResources(hostResources);
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return (
      resources.totalMemoryBytes < CI_PARALLEL_MIN_MEMORY_BYTES ||
      resources.logicalCpuCount < CI_PARALLEL_MIN_CPUS
    );
  }
  return (
    resources.totalMemoryBytes < FAST_LOCAL_CHECK_MIN_MEMORY_BYTES ||
    resources.logicalCpuCount < FAST_LOCAL_CHECK_MIN_CPUS
  );
}

function isRemoteChangedGateEnv(env: NodeJS.ProcessEnv) {
  return (
    env.OPENCLAW_CHECK_CHANGED_REMOTE_CHILD === "1" || env.OPENCLAW_CHANGED_LANES_RAW_SYNC === "1"
  );
}

function readDirectoryEntries(readDir: ReadDirectoryEntries, target: string) {
  try {
    return readDir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listExtensionEntries({ cwd, readDir }: DirectoryLookup) {
  const entries = readDirectoryEntries(readDir, path.join(cwd, EXTENSIONS_DIR));

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${EXTENSIONS_DIR}/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));
  const rootFiles = entries
    .filter((entry) => entry.isFile() && OXLINT_SOURCE_FILE_PATTERN.test(entry.name))
    .map((entry) => `${EXTENSIONS_DIR}/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));

  return {
    dirs,
    rootFiles,
  };
}

function listSourceRootTargetGroups({ cwd, readDir }: DirectoryLookup) {
  const entries = readDirectoryEntries(readDir, path.join(cwd, "src"));

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `src/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));
  const rootFiles = entries
    .filter((entry) => entry.isFile() && OXLINT_SOURCE_FILE_PATTERN.test(entry.name))
    .map((entry) => `src/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));

  return [...dirs.map((target) => [target]), ...(rootFiles.length > 0 ? [rootFiles] : [])];
}

/**
 * Runs selected oxlint shards and returns process-style success/failure.
 */
export async function main(
  extraArgs: string[] = process.argv.slice(2),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
) {
  const runner = path.resolve("scripts", "run-oxlint.mjs");
  const shardArgs = parseShardRunnerArgs(extraArgs);
  const env = resolveLocalCheckEnv(runtimeEnv);
  const shards = createOxlintShards({
    cwd: process.cwd(),
    env,
    platform: process.platform,
    splitCore: shardArgs.splitCore,
  });
  const selectedShards = selectCoreOxlintStripe(
    filterOxlintShards(shards, shardArgs.only),
    shardArgs.coreStripe,
  );

  ensureRepoToolNodeModulesLink(resolveRepoToolBinPath("oxlint"));
  const needsArtifacts = shouldPrepareExtensionPackageBoundaryArtifactsForShards(
    selectedShards,
    shardArgs.oxlintArgs,
  );
  const run = async () => {
    if (needsArtifacts) {
      const code = await runManagedCommand({
        bin: process.execPath,
        args: distArtifactEntryArgs(
          path.resolve("scripts/prepare-extension-package-boundary-artifacts.mts"),
        ),
        env,
        requireProcessTreeExit: process.platform !== "win32",
      });
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
    const shardConcurrency = resolveOxlintShardConcurrency({
      env,
      platform: process.platform,
      splitCore: shardArgs.splitCore,
    });
    const hostResources = resolveHostResources();
    // stderr: stdout may carry machine-readable oxlint output for callers.
    console.error(
      `[oxlint] shard concurrency ${Math.max(1, Math.min(shardConcurrency, selectedShards.length))} ` +
        `(cpus=${hostResources.logicalCpuCount}, memGB=${Math.round(hostResources.totalMemoryBytes / 1024 ** 3)})`,
    );
    const results = await runShards({
      concurrency: Math.max(1, Math.min(shardConcurrency, selectedShards.length)),
      entries: selectedShards,
      env,
      extraArgs: shardArgs.oxlintArgs,
      runner,
    });
    process.exitCode = results.find((status) => status !== 0) ?? 0;
  };
  if (needsArtifacts) {
    await withDistArtifactOwnership(process.cwd(), run);
  } else {
    await run();
  }
}

if (import.meta.main) {
  await main();
}

function resolveHostResources(hostResources?: HostResources) {
  if (hostResources) {
    return hostResources;
  }

  return {
    totalMemoryBytes: os.totalmem(),
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  };
}

/**
 * Parses shard-runner flags separately from forwarded oxlint args.
 */
export function parseShardRunnerArgs(args: string[]) {
  const only = new Set<string>();
  const oxlintArgs: string[] = [];
  let coreStripe: CoreStripe | undefined;
  let splitCore = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--split-core") {
      splitCore = true;
      continue;
    }
    if (arg === "--core-stripe") {
      coreStripe = parseCoreStripe(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--core-stripe=")) {
      coreStripe = parseCoreStripe(arg.slice("--core-stripe=".length));
      continue;
    }
    if (arg === "--only") {
      only.add(requireShardSelector(args[index + 1]));
      index += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      only.add(requireShardSelector(arg.slice("--only=".length)));
      continue;
    }
    oxlintArgs.push(arg);
  }

  if (coreStripe && !splitCore) {
    throw new Error("--core-stripe requires --split-core");
  }
  return { coreStripe, only, oxlintArgs, splitCore };
}

function parseCoreStripe(value: string | undefined): CoreStripe {
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? "");
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total
  ) {
    throw new Error(`--core-stripe requires INDEX/TOTAL with 1 <= INDEX <= TOTAL; got: ${value}`);
  }
  return { index, total };
}

/**
 * Filters shards by optional shard names and rejects unknown selectors.
 */
export function filterOxlintShards<T extends { name: string }>(shards: T[], only: Set<string>) {
  if (only.size === 0) {
    return shards;
  }

  const selectors = [...only];
  const unknownSelectors = selectors.filter(
    (selector) => !shards.some((shard) => matchesShardSelector(shard, selector)),
  );
  if (unknownSelectors.length > 0) {
    throw new Error(
      `Unknown oxlint shard selector${unknownSelectors.length === 1 ? "" : "s"}: ${unknownSelectors.join(", ")}`,
    );
  }

  return shards.filter((shard) =>
    selectors.some((selector) => matchesShardSelector(shard, selector)),
  );
}

/** Aggregate one deterministic, disjoint stripe into a single core Program. */
export function selectCoreOxlintStripe(shards: OxlintShard[], stripe: CoreStripe | undefined) {
  if (!stripe) {
    return shards;
  }
  if (shards.length === 0 || shards.some((shard) => !shard.name.startsWith("core:"))) {
    throw new Error("--core-stripe requires a non-empty core-only shard selection");
  }
  const targets = shards
    .filter((_, index) => index % stripe.total === stripe.index - 1)
    .flatMap((shard) => shard.args.slice(2));
  if (targets.length === 0) {
    return [];
  }
  return [
    {
      name: `core:stripe:${stripe.index}`,
      args: ["--tsconfig", CORE_TS_CONFIG, ...targets],
    },
  ];
}

export function shouldPrepareExtensionPackageBoundaryArtifactsForShards(
  shards: readonly OxlintShard[],
  extraArgs: readonly string[] = [],
) {
  return shards.some((shard) =>
    shouldPrepareExtensionPackageBoundaryArtifacts([...shard.args, ...extraArgs]),
  );
}

function requireShardSelector(value: string | undefined) {
  if (!value || value.startsWith("-")) {
    throw new Error("--only requires a shard name");
  }
  return value;
}

function matchesShardSelector(shard: { name: string }, selector: string) {
  return selector === shard.name || selector === shard.name.split(":")[0];
}

/**
 * Resolves shard concurrency from env, platform, and host resources.
 */
export function resolveOxlintShardConcurrency({
  env = process.env,
  platform = process.platform,
  hostResources,
  splitCore = false,
}: ResourceOptions & { splitCore?: boolean } = {}) {
  if (shouldRunOxlintShardsSerial({ env, platform, hostResources })) {
    return 1;
  }

  const explicitConcurrency = resolvePositiveEnvInt(env, "OPENCLAW_OXLINT_SHARD_CONCURRENCY");
  if (explicitConcurrency !== null) {
    return explicitConcurrency;
  }

  if (!splitCore) {
    return Number.MAX_SAFE_INTEGER;
  }

  const resources = resolveHostResources(hostResources);
  return Math.max(
    1,
    Math.min(DEFAULT_SPLIT_CORE_SHARD_CONCURRENCY, Math.floor(resources.logicalCpuCount / 4)),
  );
}

async function runShards({ concurrency, entries, env, extraArgs, runner }: ShardBatchOptions) {
  // Dependency-less worktrees establish their primary-checkout toolchain link
  // before this lazy import, avoiding a top-level package-resolution failure.
  const { default: pMap } = await import("p-map");
  const results = await pMap(
    entries,
    async (shard) => {
      if (isParentTerminationRequested()) {
        return undefined;
      }
      return await runShard({ env, extraArgs, runner, shard });
    },
    { concurrency, stopOnError: false },
  );
  return results.filter((status) => status !== undefined);
}

/**
 * Runs one oxlint shard with bounded output, heartbeat, and forced cleanup.
 */
export async function runShard({ env, extraArgs, runner, shard }: ShardRunnerOptions) {
  console.error(`[oxlint:${shard.name}] starting`);
  const startedAt = Date.now();
  const heartbeatMs = resolveShardHeartbeatMs(env);
  const timeoutMs = resolveShardTimeoutMs(env);
  const killGraceMs = resolveShardKillGraceMs(env);
  // The shard batch holds ownership through preparation and every consumer.
  const args =
    runner === path.resolve("scripts", "run-oxlint.mjs") &&
    shouldPrepareExtensionPackageBoundaryArtifactsForShards([shard], extraArgs)
      ? distArtifactEntryArgs(path.resolve("scripts/run-oxlint.mts"), [...shard.args, ...extraArgs])
      : [runner, ...shard.args, ...extraArgs];
  const child = spawn(process.execPath, args, {
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...env,
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    },
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const unregisterShardChild = registerShardChild({ child, killGraceMs });

  return await new Promise<number>((resolve, reject) => {
    let finished = false;
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | null = null;
    let forceKillAt: number | null = null;
    const heartbeat =
      heartbeatMs > 0
        ? setInterval(() => {
            const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
            console.error(`[oxlint:${shard.name}] still running after ${elapsedSeconds}s`);
          }, heartbeatMs)
        : null;
    heartbeat?.unref();
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
            console.error(
              `[oxlint:${shard.name}] timed out after ${elapsedSeconds}s; terminating shard`,
            );
            signalChildProcess(child, "SIGTERM");
            if (killGraceMs > 0) {
              forceKillAt = Date.now() + killGraceMs;
              forceKill = setTimeout(() => {
                console.error(`[oxlint:${shard.name}] did not exit cleanly; killing shard`);
                signalChildProcess(child, "SIGKILL");
              }, killGraceMs);
              forceKill.unref();
            } else {
              signalChildProcess(child, "SIGKILL");
            }
          }, timeoutMs)
        : null;
    timeout?.unref();
    const finish = (status: number, error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKill) {
        clearTimeout(forceKill);
      }
      forceKillAt = null;
      unregisterShardChild();
      console.error(`[oxlint:${shard.name}] finished`);
      if (error) {
        reject(error);
      } else {
        resolve(status);
      }
    };
    const finishAfterForcedTeardown = async (status: number) => {
      const graceRemainingMs =
        forceKillAt === null ? killGraceMs : Math.max(0, forceKillAt - Date.now());
      if (graceRemainingMs > 0) {
        await waitForChildProcessGroupExit(child, graceRemainingMs);
      }
      if (isChildProcessGroupAlive(child)) {
        signalChildProcess(child, "SIGKILL");
      }
      await waitForChildProcessGroupExit(child, POST_FORCE_KILL_WAIT_MS);
      if (isChildProcessGroupAlive(child)) {
        finish(
          1,
          Object.assign(new Error("oxlint shard process group did not exit"), {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "live",
          }),
        );
      } else {
        finish(status);
      }
    };
    child.once("error", (error) => {
      console.error(error);
      finish(1);
    });
    child.once("close", (status) => {
      const exitStatus = parentTerminationSignal
        ? getSignalExitCode(parentTerminationSignal)
        : timedOut
          ? 124
          : (status ?? 1);
      if (isChildProcessGroupAlive(child)) {
        void finishAfterForcedTeardown(exitStatus || 1);
        return;
      }
      finish(exitStatus);
    });
  });
}

/**
 * Reads the shard heartbeat interval.
 */
export function resolveShardHeartbeatMs(env: NodeJS.ProcessEnv) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS",
    DEFAULT_SHARD_HEARTBEAT_MS,
  );
}

/**
 * Reads the per-shard timeout.
 */
export function resolveShardTimeoutMs(env: NodeJS.ProcessEnv) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_TIMEOUT_MS",
    DEFAULT_SHARD_TIMEOUT_MS,
  );
}

/**
 * Reads the graceful shutdown window before SIGKILL.
 */
export function resolveShardKillGraceMs(env: NodeJS.ProcessEnv) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS",
    DEFAULT_SHARD_KILL_GRACE_MS,
  );
}

function resolveNonNegativeEnvInt(env: NodeJS.ProcessEnv, key: string, defaultValue: number) {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  const text = rawValue.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${key} must be a non-negative integer; got: ${rawValue}`);
  }
  const parsedValue = Number(text);
  if (!Number.isSafeInteger(parsedValue)) {
    throw new Error(`${key} must be a non-negative integer; got: ${rawValue}`);
  }
  return parsedValue;
}

function resolvePositiveEnvInt(env: NodeJS.ProcessEnv, key: string) {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === "") {
    return null;
  }

  return parsePositiveEnvInt(rawValue, key);
}

function resolvePositiveEnvIntWithFallback(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
) {
  const rawValue = env[key];
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  return parsePositiveEnvInt(rawValue, key);
}

function parsePositiveEnvInt(rawValue: string, key: string) {
  const text = rawValue.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${key} must be a positive integer; got: ${rawValue}`);
  }
  const parsedValue = Number(text);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${key} must be a positive integer; got: ${rawValue}`);
  }
  return parsedValue;
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) {
    return;
  }

  const reportSignalError = (error: unknown) => {
    if (!isNodeErrorCode(error, "ESRCH")) {
      console.error(error);
    }
  };
  terminateManagedChild(child, signal, {
    onChildSignalError: reportSignalError,
    onProcessGroupSignalError: reportSignalError,
    processGroupFallback: "never",
    useWindowsTaskkill: false,
  });
}

function isChildProcessGroupAlive(child: ChildProcess) {
  return inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm" }) === "live";
}

function waitForChildProcessGroupExit(child: ChildProcess, timeoutMs: number) {
  return waitForManagedProcessGroupExit(child, timeoutMs, { errorPolicy: "alive-on-eperm" });
}

function registerShardChild(entry: ActiveShardChild) {
  installParentSignalForwarding();
  ACTIVE_SHARD_CHILDREN.add(entry);
  return () => {
    ACTIVE_SHARD_CHILDREN.delete(entry);
    if (ACTIVE_SHARD_CHILDREN.size === 0 && parentTerminationForceKill) {
      clearTimeout(parentTerminationForceKill);
      parentTerminationForceKill = null;
    }
  };
}

function installParentSignalForwarding() {
  if (parentSignalForwardingInstalled) {
    return;
  }
  parentSignalForwardingInstalled = true;
  for (const signal of PARENT_TERMINATION_SIGNALS) {
    process.on(signal, () => {
      parentTerminationSignal = signal;
      process.exitCode = getSignalExitCode(signal);
      if (ACTIVE_SHARD_CHILDREN.size === 0) {
        process.exit(process.exitCode);
      }
      signalActiveShardChildren(signal);
      scheduleParentTerminationForceKill();
    });
  }
  process.once("exit", () => {
    signalActiveShardChildren("SIGTERM");
  });
}

function isParentTerminationRequested() {
  return parentTerminationSignal !== null;
}

function signalActiveShardChildren(signal: NodeJS.Signals) {
  for (const entry of ACTIVE_SHARD_CHILDREN) {
    signalChildProcess(entry.child, signal);
  }
}

function scheduleParentTerminationForceKill() {
  if (parentTerminationForceKill) {
    return;
  }
  const killGraceMs = Math.max(
    0,
    ...Array.from(ACTIVE_SHARD_CHILDREN, (entry) => entry.killGraceMs),
  );
  if (killGraceMs === 0) {
    signalActiveShardChildren("SIGKILL");
    return;
  }
  parentTerminationForceKill = setTimeout(() => {
    parentTerminationForceKill = null;
    signalActiveShardChildren("SIGKILL");
  }, killGraceMs);
  parentTerminationForceKill.unref();
}

function getSignalExitCode(signal: NodeJS.Signals) {
  return signal === "SIGINT" ? 130 : 143;
}

function isNodeErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
