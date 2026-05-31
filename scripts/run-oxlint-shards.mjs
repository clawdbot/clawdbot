import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";

const DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE = 8;
const DEFAULT_SHARD_HEARTBEAT_MS = 30_000;
const DEFAULT_SHARD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SHARD_KILL_GRACE_MS = 5_000;
const FAST_LOCAL_CHECK_MIN_CPUS = 12;
const FAST_LOCAL_CHECK_MIN_MEMORY_BYTES = 48 * 1024 ** 3;
const EXTENSION_TS_CONFIG = "config/tsconfig/oxlint.extensions.json";
const EXTENSIONS_DIR = "extensions";
const OXLINT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const PARENT_TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"];
const ACTIVE_SHARD_CHILDREN = new Set();
let parentTerminationSignal = null;
let parentTerminationForceKill = null;
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

export function createOxlintShards({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  readDir = fs.readdirSync,
  splitCore = false,
} = {}) {
  const coreShards = splitCore ? createCoreOxlintShards({ cwd, readDir }) : [CORE_SHARD];
  const extensionShards =
    platform === "win32" ? createWindowsExtensionShards({ cwd, env, readDir }) : [EXTENSIONS_SHARD];

  return [...coreShards, ...extensionShards, SCRIPTS_SHARD];
}

export function createCoreOxlintShards({ cwd = process.cwd(), readDir = fs.readdirSync } = {}) {
  const sourceShards = listSourceRootTargetGroups({ cwd, readDir }).map((targets) => ({
    name: targets.length === 1 ? `core:${targets[0].replaceAll("/", ":")}` : "core:src:root",
    args: ["--tsconfig", CORE_TS_CONFIG, ...targets],
  }));
  const sourceEntries = sourceShards.length > 0 ? sourceShards : [createCoreShard("src")];

  return [...sourceEntries, ...CORE_SPLIT_TARGETS.map((target) => createCoreShard(target))];
}

function createCoreShard(target) {
  return {
    name: `core:${target}`,
    args: ["--tsconfig", CORE_TS_CONFIG, target],
  };
}

export function createWindowsExtensionShards({
  cwd = process.cwd(),
  env = process.env,
  readDir = fs.readdirSync,
} = {}) {
  const entries = listExtensionEntries({ cwd, readDir });
  if (entries.dirs.length === 0 && entries.rootFiles.length === 0) {
    return [EXTENSIONS_SHARD];
  }

  const chunkSize = resolveWindowsExtensionChunkSize(env);
  const shards = [];

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

export function resolveWindowsExtensionChunkSize(env = process.env) {
  const rawValue = env.OPENCLAW_OXLINT_WINDOWS_EXTENSION_CHUNK_SIZE;
  if (rawValue === undefined) {
    return DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : DEFAULT_WINDOWS_EXTENSION_CHUNK_SIZE;
}

export function shouldRunOxlintShardsSerial({
  env = process.env,
  platform = process.platform,
  hostResources,
} = {}) {
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
  if (localCheckMode === "full" || localCheckMode === "fast") {
    return false;
  }
  if (localCheckMode === "throttled" || localCheckMode === "low-memory") {
    return true;
  }
  const resources = resolveHostResources(hostResources);
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return (
      resources.totalMemoryBytes < FAST_LOCAL_CHECK_MIN_MEMORY_BYTES ||
      resources.logicalCpuCount < FAST_LOCAL_CHECK_MIN_CPUS
    );
  }
  return (
    resources.totalMemoryBytes < FAST_LOCAL_CHECK_MIN_MEMORY_BYTES ||
    resources.logicalCpuCount < FAST_LOCAL_CHECK_MIN_CPUS
  );
}

function listExtensionEntries({ cwd, readDir }) {
  let entries;
  try {
    entries = readDir(path.join(cwd, EXTENSIONS_DIR), { withFileTypes: true });
  } catch {
    return {
      dirs: [],
      rootFiles: [],
    };
  }

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

function listSourceRootTargetGroups({ cwd, readDir }) {
  let entries;
  try {
    entries = readDir(path.join(cwd, "src"), { withFileTypes: true });
  } catch {
    return [];
  }

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

export async function main(extraArgs = process.argv.slice(2), runtimeEnv = process.env) {
  const runner = path.resolve("scripts", "run-oxlint.mjs");
  const shardArgs = parseShardRunnerArgs(extraArgs);
  const env = resolveLocalHeavyCheckEnv(runtimeEnv);
  const hasMetadataOnlyFlag = shardArgs.oxlintArgs.some((arg) =>
    ["--help", "-h", "--version", "-V", "--rules", "--print-config", "--init"].includes(arg),
  );
  const shouldAcquireParentLock =
    !hasMetadataOnlyFlag ||
    shouldAcquireLocalHeavyCheckLockForOxlint(shardArgs.oxlintArgs, {
      cwd: process.cwd(),
      env,
    });
  const releaseLock =
    env.OPENCLAW_OXLINT_SKIP_LOCK === "1"
      ? () => {}
      : shouldAcquireParentLock
        ? acquireLocalHeavyCheckLockSync({
            cwd: process.cwd(),
            env,
            toolName: "oxlint shards",
          })
        : () => {};

  const shards = createOxlintShards({
    cwd: process.cwd(),
    env,
    platform: process.platform,
    splitCore: shardArgs.splitCore,
  });
  const selectedShards = filterOxlintShards(shards, shardArgs.only);

  try {
    const prepareResult = spawnSync(
      process.execPath,
      [path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs")],
      {
        stdio: "inherit",
        env,
      },
    );

    if (prepareResult.error) {
      throw prepareResult.error;
    }
    if ((prepareResult.status ?? 1) !== 0) {
      process.exitCode = prepareResult.status ?? 1;
    } else {
      const runSerial =
        shardArgs.splitCore ||
        shouldRunOxlintShardsSerial({
          env,
          platform: process.platform,
        });
      const results = runSerial
        ? await runShardsSerial({
            entries: selectedShards,
            env,
            extraArgs: shardArgs.oxlintArgs,
            runner,
          })
        : await Promise.all(
            selectedShards.map((shard) =>
              runShard({ env, extraArgs: shardArgs.oxlintArgs, runner, shard }),
            ),
          );
      process.exitCode = results.find((status) => status !== 0) ?? 0;
    }
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  await main();
}

function resolveHostResources(hostResources) {
  if (hostResources) {
    return hostResources;
  }

  return {
    totalMemoryBytes: os.totalmem(),
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
  };
}

export function parseShardRunnerArgs(args) {
  const only = new Set();
  const oxlintArgs = [];
  let splitCore = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--split-core") {
      splitCore = true;
      continue;
    }
    if (arg === "--only") {
      const value = args[index + 1];
      if (value) {
        only.add(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--only=")) {
      const value = arg.slice("--only=".length);
      if (value) {
        only.add(value);
      }
      continue;
    }
    oxlintArgs.push(arg);
  }

  return { only, oxlintArgs, splitCore };
}

export function filterOxlintShards(shards, only) {
  if (only.size === 0) {
    return shards;
  }

  return shards.filter((shard) => only.has(shard.name) || only.has(shard.name.split(":")[0]));
}

async function runShardsSerial({ entries, env, extraArgs, runner }) {
  const results = [];
  for (const shard of entries) {
    results.push(await runShard({ env, extraArgs, runner, shard }));
    if (isParentTerminationRequested()) {
      break;
    }
  }
  return results;
}

export async function runShard({ env, extraArgs, runner, shard }) {
  console.error(`[oxlint:${shard.name}] starting`);
  const startedAt = Date.now();
  const heartbeatMs = resolveShardHeartbeatMs(env);
  const timeoutMs = resolveShardTimeoutMs(env);
  const killGraceMs = resolveShardKillGraceMs(env);
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(process.execPath, [runner, ...shard.args, ...extraArgs], {
    stdio: "inherit",
    detached: useProcessGroup,
    env: {
      ...env,
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    },
  });
  const unregisterShardChild = registerShardChild({ child, killGraceMs, useProcessGroup });

  return await new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let forceKill = null;
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
            signalChildProcess({ child, signal: "SIGTERM", useProcessGroup });
            if (killGraceMs > 0) {
              forceKill = setTimeout(() => {
                console.error(`[oxlint:${shard.name}] did not exit cleanly; killing shard`);
                signalChildProcess({ child, signal: "SIGKILL", useProcessGroup });
              }, killGraceMs);
              forceKill.unref();
            } else {
              signalChildProcess({ child, signal: "SIGKILL", useProcessGroup });
            }
          }, timeoutMs)
        : null;
    timeout?.unref();
    const finish = (status) => {
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
      unregisterShardChild();
      console.error(`[oxlint:${shard.name}] finished`);
      resolve(status);
    };
    child.once("error", (error) => {
      console.error(error);
      finish(1);
    });
    child.once("close", (status) => {
      finish(
        parentTerminationSignal
          ? getSignalExitCode(parentTerminationSignal)
          : timedOut
            ? 124
            : (status ?? 1),
      );
    });
  });
}

export function resolveShardHeartbeatMs(env) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS",
    DEFAULT_SHARD_HEARTBEAT_MS,
  );
}

export function resolveShardTimeoutMs(env) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_TIMEOUT_MS",
    DEFAULT_SHARD_TIMEOUT_MS,
  );
}

export function resolveShardKillGraceMs(env) {
  return resolveNonNegativeEnvInt(
    env,
    "OPENCLAW_OXLINT_SHARD_KILL_GRACE_MS",
    DEFAULT_SHARD_KILL_GRACE_MS,
  );
}

function resolveNonNegativeEnvInt(env, key, defaultValue) {
  const rawValue = env[key];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : defaultValue;
}

function signalChildProcess({ child, signal, useProcessGroup }) {
  if (!child.pid) {
    return;
  }

  try {
    if (useProcessGroup) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error(error);
    }
  }
}

function registerShardChild(entry) {
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

function signalActiveShardChildren(signal) {
  for (const entry of ACTIVE_SHARD_CHILDREN) {
    signalChildProcess({ ...entry, signal });
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

function getSignalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}
