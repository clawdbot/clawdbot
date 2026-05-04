import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GIB = 1024 ** 3;
const DEFAULT_LOCAL_GO_GC = "30";
const DEFAULT_LOCAL_GO_MEMORY_LIMIT = "3GiB";
const DEFAULT_LOCAL_TSGO_BUILD_INFO_FILE = ".artifacts/tsgo-cache/root.tsbuildinfo";
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_POLL_MS = 500;
const DEFAULT_LOCK_PROGRESS_MS = 15 * 1000;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;
const DEFAULT_FAST_LOCAL_CHECK_MIN_MEMORY_BYTES = 48 * GIB;
const DEFAULT_FAST_LOCAL_CHECK_MIN_CPUS = 12;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function isLocalCheckEnabled(env) {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

function isCiLikeEnv(env = process.env) {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}

export function resolveLocalHeavyCheckEnv(env = process.env) {
  if (isCiLikeEnv(env) || isLocalCheckEnabled(env)) {
    return env;
  }

  return {
    ...env,
    OPENCLAW_LOCAL_CHECK: "1",
  };
}

function hasFlag(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

export function applyLocalTsgoPolicy(args, env, hostResources) {
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

  if (shouldThrottleLocalHeavyChecks(nextEnv, hostResources, "auto")) {
    insertBeforeSeparator(nextArgs, "--singleThreaded");
    insertBeforeSeparator(nextArgs, "--checkers", "1");

    if (!nextEnv.GOGC) {
      nextEnv.GOGC = DEFAULT_LOCAL_GO_GC;
    }
    if (!nextEnv.GOMEMLIMIT) {
      nextEnv.GOMEMLIMIT = DEFAULT_LOCAL_GO_MEMORY_LIMIT;
    }
  }
  if (nextEnv.OPENCLAW_TSGO_PPROF_DIR && !hasFlag(nextArgs, "--pprofDir")) {
    insertBeforeSeparator(nextArgs, "--pprofDir", nextEnv.OPENCLAW_TSGO_PPROF_DIR);
  }

  return { env: nextEnv, args: nextArgs };
}

export function applyLocalOxlintPolicy(args, env, hostResources) {
  const nextEnv = { ...env };
  const nextArgs = [...args];

  insertBeforeSeparator(nextArgs, "--type-aware");
  insertBeforeSeparator(nextArgs, "--tsconfig", "config/tsconfig/oxlint.json");
  insertBeforeSeparator(nextArgs, "--allow", "eslint/no-underscore-dangle");
  if (
    !hasFlag(nextArgs, "--report-unused-disable-directives") &&
    !hasFlag(nextArgs, "--report-unused-disable-directives-severity")
  ) {
    insertBeforeSeparator(nextArgs, "--report-unused-disable-directives-severity", "error");
  }

  if (shouldThrottleLocalHeavyChecks(nextEnv, hostResources) && !hasFlag(nextArgs, "--threads")) {
    insertBeforeSeparator(nextArgs, "--threads=1");
  }

  return { env: nextEnv, args: nextArgs };
}

export function shouldAcquireLocalHeavyCheckLockForOxlint(
  args,
  { cwd = process.cwd(), env = process.env } = {},
) {
  if (env.OPENCLAW_OXLINT_FORCE_LOCK === "1") {
    return true;
  }

  if (
    args.some(
      (arg) =>
        arg === "--help" ||
        arg === "-h" ||
        arg === "--version" ||
        arg === "-V" ||
        arg === "--rules" ||
        arg === "--print-config" ||
        arg === "--init",
    )
  ) {
    return false;
  }

  const separatorIndex = args.indexOf("--");
  const candidateArgs = (() => {
    if (separatorIndex !== -1) {
      return args.slice(separatorIndex + 1);
    }
    const firstFlagIndex = args.findIndex((arg) => arg.startsWith("-"));
    return firstFlagIndex === -1 ? args : args.slice(0, firstFlagIndex);
  })();
  const explicitTargets = candidateArgs.filter((arg) => arg.length > 0 && !arg.startsWith("-"));
  if (explicitTargets.length === 0) {
    return true;
  }

  return !explicitTargets.every((target) => {
    try {
      return fs.statSync(path.resolve(cwd, target)).isFile();
    } catch {
      return false;
    }
  });
}

export function shouldAcquireLocalHeavyCheckLockForTsgo(args, env = process.env) {
  if (env.OPENCLAW_TSGO_FORCE_LOCK === "1") {
    return true;
  }

  return !args.some(
    (arg) =>
      arg === "--help" ||
      arg === "-h" ||
      arg === "--version" ||
      arg === "-v" ||
      arg === "--init" ||
      arg === "--showConfig",
  );
}

function shouldThrottleLocalHeavyChecks(env, hostResources, defaultMode = "throttled") {
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

export function acquireLocalHeavyCheckLockSync(params) {
  const env = params.env ?? process.env;

  if (!isLocalCheckEnabled(env)) {
    return () => {};
  }

  const commonDir = resolveGitCommonDir(params.cwd);
  const locksDir = path.join(commonDir, "openclaw-local-checks");
  const lockDir = path.join(locksDir, `${params.lockName ?? "heavy-check"}.lock`);
  const ownerPath = path.join(lockDir, "owner.json");
  const timeoutMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
  );
  const pollMs = readPositiveInt(env.OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS, DEFAULT_LOCK_POLL_MS);
  const progressMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_LOCK_PROGRESS_MS,
    DEFAULT_LOCK_PROGRESS_MS,
  );
  const staleLockMs = readPositiveInt(
    env.OPENCLAW_HEAVY_CHECK_STALE_LOCK_MS,
    DEFAULT_STALE_LOCK_MS,
  );
  const startedAt = Date.now();
  let waitingLogged = false;
  let lastProgressAt = 0;

  fs.mkdirSync(locksDir, { recursive: true });
  if (!params.lockName) {
    cleanupLegacyLockDirs(locksDir, staleLockMs);
  }

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      writeOwnerFile(ownerPath, {
        pid: process.pid,
        tool: params.toolName,
        cwd: params.cwd,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      });
      return () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const owner = readOwnerFile(ownerPath);
      if (shouldReclaimLock({ owner, lockDir, staleLockMs })) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        const ownerLabel = describeOwner(owner);
        throw new Error(
          `[${params.toolName}] timed out waiting for the local heavy-check lock at ${lockDir}${
            ownerLabel ? ` (${ownerLabel})` : ""
          }. If no local heavy checks are still running, remove the stale lock and retry.`,
          { cause: error },
        );
      }

      if (!waitingLogged) {
        const ownerLabel = describeOwner(owner);
        console.error(
          `[${params.toolName}] queued behind the local heavy-check lock${
            ownerLabel ? ` held by ${ownerLabel}` : ""
          }...`,
        );
        waitingLogged = true;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt >= progressMs) {
        const ownerLabel = describeOwner(owner);
        console.error(
          `[${params.toolName}] still waiting ${formatElapsedMs(elapsedMs)} for the local heavy-check lock${
            ownerLabel ? ` held by ${ownerLabel}` : ""
          }...`,
        );
        lastProgressAt = Date.now();
      }

      sleepSync(pollMs);
    }
  }
}

function resolveGitCommonDir(cwd) {
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

function cleanupLegacyLockDirs(locksDir, staleLockMs) {
  for (const legacyLockName of ["test"]) {
    const legacyLockDir = path.join(locksDir, `${legacyLockName}.lock`);
    if (!fs.existsSync(legacyLockDir)) {
      continue;
    }

    const owner = readOwnerFile(path.join(legacyLockDir, "owner.json"));
    if (shouldReclaimLock({ owner, lockDir: legacyLockDir, staleLockMs })) {
      fs.rmSync(legacyLockDir, { recursive: true, force: true });
    }
  }
}

function insertBeforeSeparator(args, ...items) {
  if (items.length > 0 && hasFlag(args, items[0])) {
    return;
  }

  const separatorIndex = args.indexOf("--");
  const insertIndex = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(insertIndex, 0, ...items);
}

function readLocalCheckMode(env, defaultMode) {
  const raw = env.OPENCLAW_LOCAL_CHECK_MODE?.trim().toLowerCase();
  if (raw === "throttled" || raw === "low-memory") {
    return "throttled";
  }
  if (raw === "full" || raw === "fast") {
    return "full";
  }
  return defaultMode;
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

function readPositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeOwnerFile(ownerPath, owner) {
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function readOwnerFile(ownerPath) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function isAlreadyExistsError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function shouldReclaimLock({ owner, lockDir, staleLockMs }) {
  if (owner && typeof owner.pid === "number") {
    return !isProcessAlive(owner.pid);
  }

  try {
    const stats = fs.statSync(lockDir);
    return Date.now() - stats.mtimeMs >= staleLockMs;
  } catch {
    return true;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function describeOwner(owner) {
  if (!owner || typeof owner !== "object") {
    return "";
  }

  const tool = typeof owner.tool === "string" ? owner.tool : "unknown-tool";
  const pid = typeof owner.pid === "number" ? `pid ${owner.pid}` : "unknown pid";
  const cwd = typeof owner.cwd === "string" ? owner.cwd : "unknown cwd";
  return `${tool}, ${pid}, cwd ${cwd}`;
}

function formatElapsedMs(elapsedMs) {
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }
  const seconds = elapsedMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainderSeconds}s`;
}

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}
