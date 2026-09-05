// Coordinates gateway lock files, ports, and stale owner detection.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { hasErrnoCode } from "./errno.js";
import { createFileLockManager } from "./file-lock-manager.js";
import {
  isGatewayArgv,
  isOpenClawArgv,
  isOpenClawCommandArgv,
  parseProcCmdline,
} from "./gateway-process-argv.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./node-sqlite.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { acquireGatewayLifecycleCoordinator } from "./state-database-coordinator.js";
import { readWindowsProcessArgsSync } from "./windows-port-pids.js";
import { readWindowsProcessStartTimeSync } from "./windows-process-start.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;
const GATEWAY_LOCKS = createFileLockManager("openclaw.gateway-lock");

type LockPayload = {
  pid: number;
  ownerId?: string;
  /** Present when Gateway cron writes use the dynamic-default ownership projection. */
  cronOwnerProjection?: "dynamic-default-v1";
  createdAt: string;
  configPath: string;
  port?: number;
  role?: GatewayLockRole;
  stateDir?: string;
  startTime?: number;
};

const LockPayloadSchema = z.object({
  pid: z.number(),
  ownerId: z.string().min(1).optional(),
  cronOwnerProjection: z.literal("dynamic-default-v1").optional(),
  createdAt: z.string(),
  configPath: z.string(),
  port: z.number().int().min(1).max(65_535).optional(),
  role: z
    .enum(["gateway", "agent-embedded", "skill-workshop-apply", "sqlite-maintenance"])
    .optional(),
  stateDir: z.string().optional(),
  startTime: z.number().optional(),
}) as z.ZodType<LockPayload>;

type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  configPath: string;
  stateDir: string;
  releaseInTree: () => Promise<void>;
  release: () => Promise<void>;
};

type GatewayLockRole = "gateway" | "agent-embedded" | "skill-workshop-apply" | "sqlite-maintenance";

export type GatewayLockIdentity = {
  pid: number;
  ownerId?: string;
  cronOwnerProjection?: "dynamic-default-v1";
  createdAt: string;
  port: number;
  startTime?: number;
};

export function isSameGatewayLockIdentity(
  previous: GatewayLockIdentity,
  current: GatewayLockIdentity,
): boolean {
  if (previous.ownerId && current.ownerId) {
    return previous.ownerId === current.ownerId;
  }
  return (
    previous.pid === current.pid &&
    previous.createdAt === current.createdAt &&
    previous.startTime === current.startTime
  );
}

export type GatewayLockOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  allowInTests?: boolean;
  platform?: NodeJS.Platform;
  port?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockDir?: string;
  role?: GatewayLockRole;
  /** Override process command-line reader (testing seam). */
  readProcessCmdline?: (pid: number) => string[] | null;
  /** Override process start-identity reader (testing seam). */
  readProcessStartTime?: (pid: number) => number | null;
};

export class GatewayLockError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

function readLinuxCmdline(pid: number): string[] | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return parseProcCmdline(raw);
  } catch {
    return null;
  }
}

const CMDLINE_EXEC_TIMEOUT_MS = 1000;

function readWindowsCmdline(pid: number): string[] | null {
  return readWindowsProcessArgsSync(pid, CMDLINE_EXEC_TIMEOUT_MS);
}

/**
 * Read the command line of a macOS/BSD process via `ps`.
 *
 * `ps -o command=` outputs an unquoted flat string, so the naive whitespace
 * split will misparse paths containing spaces. This is acceptable because
 * standard macOS install paths do not contain spaces, and when the split
 * does fail the caller falls back to "alive" (conservative).
 */
function readDarwinCmdline(pid: number): string[] | null {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      env: resolveDiagnosticProcessEnv(),
      encoding: "utf8",
      timeout: CMDLINE_EXEC_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = raw.trim();
    if (!line) {
      return null;
    }
    return line.split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

function readProcessStartTime(pid: number, platform: NodeJS.Platform): number | null {
  if (platform !== process.platform) {
    return null;
  }
  return platform === "win32"
    ? readWindowsProcessStartTimeSync(pid, CMDLINE_EXEC_TIMEOUT_MS)
    : getFileLockProcessStartTime(pid);
}

function defaultReadProcessCmdline(pid: number, platform: NodeJS.Platform): string[] | null {
  if (platform === "linux") {
    return readLinuxCmdline(pid);
  }
  if (platform === "win32") {
    return readWindowsCmdline(pid);
  }
  if (platform === "darwin") {
    return readDarwinCmdline(pid);
  }
  return null;
}

async function resolveGatewayOwnerStatus(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  readCmdline?: (pid: number) => string[] | null,
  readStartTime?: (pid: number) => number | null,
  opts: { trustUnknownCmdlineOwner?: boolean } = {},
): Promise<LockOwnerStatus> {
  const role = payload?.role ?? "gateway";
  if (!isPidAlive(pid)) {
    return "dead";
  }

  // Process start identity catches PID recycling even when the replacement
  // process has the same argv shape.
  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = (
      readStartTime ?? ((ownerPid) => readProcessStartTime(ownerPid, platform))
    )(pid);
    if (currentStartTime != null) {
      return currentStartTime === payloadStartTime ? "alive" : "dead";
    }
  }

  const readFn = readCmdline ?? ((p: number) => defaultReadProcessCmdline(p, platform));
  if (
    role === "agent-embedded" ||
    role === "sqlite-maintenance" ||
    role === "skill-workshop-apply"
  ) {
    const args = readFn(pid);
    if (!args) {
      return "unknown";
    }
    if (role === "agent-embedded") {
      // The role covers every direct embedded surface (agent --local, agent exec,
      // local TUI, and CLI model probes), so validate the owning OpenClaw process
      // instead of baking one command spelling into stale-lock recovery.
      return isOpenClawArgv(args) ? "alive" : "dead";
    }
    const command = role === "sqlite-maintenance" ? "doctor" : "skills";
    return isOpenClawCommandArgv(args, command) ? "alive" : "dead";
  }

  const args = readFn(pid);
  if (!args) {
    // Cmdline reader unavailable or failed. On Linux legacy locks (no
    // start-time), "unknown" lets the stale-lock heuristic eventually reclaim
    // very old locks. On win32/darwin/other, conservatively assume "alive" to
    // preserve single-instance guarantees when wmic/ps is unavailable.
    return platform === "linux" || opts.trustUnknownCmdlineOwner === false ? "unknown" : "alive";
  }
  // Long-running gateways retitle themselves so macOS/BSD process inspection
  // can identify the owner after the original argv is no longer available.
  return isGatewayArgv(args, { allowGatewayBinary: true }) ? "alive" : "dead";
}

async function readLockPayload(
  lockPath: string,
  requireInspection = false,
): Promise<LockPayload | null> {
  try {
    const payload = parseGatewayLockPayload(await fs.readFile(lockPath, "utf8"));
    if (requireInspection && !payload) {
      throw new GatewayLockError("Gateway lock payload could not be verified");
    }
    return payload;
  } catch (error) {
    if (requireInspection && !hasErrnoCode(error, "ENOENT")) {
      throw new GatewayLockError("Gateway lock inspection is unavailable", error);
    }
    return null;
  }
}

function parseGatewayLockPayload(raw: string): LockPayload | null {
  return safeParseJsonWithSchema(LockPayloadSchema, raw);
}

async function shouldReclaimGatewayLock(params: {
  lockPath: string;
  payload: LockPayload | null;
  staleMs: number;
  now: () => number;
  platform: NodeJS.Platform;
  readProcessCmdline?: (pid: number) => string[] | null;
  readProcessStartTime?: (pid: number) => number | null;
}): Promise<boolean> {
  const ownerPid = params.payload?.pid;
  const ownerStatus = ownerPid
    ? await resolveGatewayOwnerStatus(
        ownerPid,
        params.payload,
        params.platform,
        params.readProcessCmdline,
        params.readProcessStartTime,
      )
    : "unknown";
  if (ownerPid) {
    return ownerStatus === "dead";
  }
  if (params.payload?.createdAt) {
    const createdAt = Date.parse(params.payload.createdAt);
    if (Number.isFinite(createdAt) && params.now() - createdAt > params.staleMs) {
      return true;
    }
  }
  try {
    const stat = await fs.stat(params.lockPath);
    return params.now() - stat.mtimeMs > params.staleMs;
  } catch {
    // An unreadable lock can still belong to a healthy gateway. Fail closed.
    return false;
  }
}

function resolveGatewayLockPaths(env: NodeJS.ProcessEnv, suppliedLockDir?: string) {
  const resolvedStateDir = resolveStateDir(env);
  const stateDir = resolveIdentityPathViaExistingAncestorSync(resolvedStateDir);
  const lockDir = suppliedLockDir ?? resolveGatewayLockDir(stateDir);
  const configPath = resolveConfigPath(env, resolvedStateDir);
  const configHash = sha256HexPrefixCore(configPath, 8);
  return {
    configLockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateDir,
    stateLockPath: path.join(lockDir, "gateway.state.lock"),
  };
}

type GatewayLockObservationOptions = Pick<
  GatewayLockOptions,
  "env" | "lockDir" | "platform" | "readProcessCmdline" | "readProcessStartTime"
> & { requireInspection?: boolean };

export async function readActiveGatewayLockPort(
  opts: GatewayLockObservationOptions = {},
): Promise<number | undefined> {
  return (await readActiveGatewayLockIdentity(opts))?.port;
}

export async function readActiveGatewayLockIdentity(
  opts: GatewayLockObservationOptions = {},
): Promise<GatewayLockIdentity | undefined> {
  const env = opts.env ?? process.env;
  const { configLockPath, stateLockPath } = resolveGatewayLockPaths(env, opts.lockDir);
  const configIdentity = await readVerifiedGatewayLockIdentity(configLockPath, opts);
  return configIdentity ?? (await readVerifiedGatewayLockIdentity(stateLockPath, opts));
}

async function readVerifiedGatewayLockIdentity(
  lockPath: string,
  opts: GatewayLockObservationOptions,
): Promise<GatewayLockIdentity | undefined> {
  const payload = await readLockPayload(lockPath, opts.requireInspection);
  if (!payload || (payload.role && payload.role !== "gateway")) {
    return undefined;
  }
  const ownerStatus = await resolveGatewayOwnerStatus(
    payload.pid,
    payload,
    opts.platform ?? process.platform,
    opts.readProcessCmdline,
    opts.readProcessStartTime,
    { trustUnknownCmdlineOwner: false },
  );
  // Discovery may omit an unverifiable owner; mutation preflight must preserve unknown.
  if (
    opts.requireInspection &&
    ownerStatus !== "dead" &&
    (ownerStatus === "unknown" || !payload.port)
  ) {
    throw new GatewayLockError("Gateway lock owner identity could not be verified");
  }
  if (ownerStatus !== "alive" || !payload.port) {
    return undefined;
  }
  return {
    pid: payload.pid,
    ...(payload.ownerId ? { ownerId: payload.ownerId } : {}),
    ...(payload.cronOwnerProjection ? { cronOwnerProjection: payload.cronOwnerProjection } : {}),
    createdAt: payload.createdAt,
    port: payload.port,
    ...(payload.startTime !== undefined ? { startTime: payload.startTime } : {}),
  };
}

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const env = opts.env ?? process.env;
  const allowInTests = opts.allowInTests === true;
  if (!allowInTests && (env.VITEST || env.NODE_ENV === "test")) {
    return null;
  }
  const role = opts.role ?? "gateway";
  const ownerId = randomUUID();
  const paths = resolveGatewayLockPaths(env, opts.lockDir);
  let stateLifecycle: ReturnType<typeof acquireGatewayLifecycleCoordinator>;
  try {
    stateLifecycle = acquireGatewayLifecycleCoordinator({
      databasePath: path.join(paths.stateDir, "state", "openclaw.sqlite"),
      busyTimeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    throw new GatewayLockError("failed to acquire gateway state ownership", error);
  }
  let stateLock: Awaited<ReturnType<typeof acquireLockFile>>;
  try {
    stateLock = await acquireLockFile({
      ...opts,
      configPath: paths.configPath,
      env,
      lockPath: paths.stateLockPath,
      role,
      stateDir: paths.stateDir,
      ownerId,
    });
  } catch (error) {
    stateLifecycle.release();
    throw error;
  }
  const shouldAcquireConfigLock = role !== "gateway" || env.OPENCLAW_ALLOW_MULTI_GATEWAY !== "1";
  if (!shouldAcquireConfigLock) {
    let inTreeReleased = false;
    const releaseInTree = async () => {
      if (inTreeReleased) {
        return;
      }
      inTreeReleased = true;
      await stateLock.release();
    };
    return {
      ...stateLock,
      stateDir: paths.stateDir,
      stateLockPath: stateLock.lockPath,
      releaseInTree,
      release: async () => {
        let releaseError: unknown;
        await releaseInTree().catch((error: unknown) => {
          releaseError = error;
        });
        try {
          stateLifecycle.release();
        } catch (error) {
          releaseError ??= error;
        }
        if (releaseError) {
          throw new GatewayLockError("failed to release gateway state ownership", releaseError);
        }
      },
    };
  }

  try {
    const configLock = await acquireLockFile({
      ...opts,
      configPath: paths.configPath,
      env,
      lockPath: paths.configLockPath,
      role,
      stateDir: paths.stateDir,
      ownerId,
    });
    let inTreeReleased = false;
    const releaseInTree = async () => {
      if (inTreeReleased) {
        return;
      }
      inTreeReleased = true;
      let releaseError: Error | undefined;
      try {
        await configLock.release();
      } catch (error) {
        releaseError =
          error instanceof Error
            ? error
            : new GatewayLockError("failed to release config lock", error);
      }
      try {
        await stateLock.release();
      } catch (error) {
        releaseError ??=
          error instanceof Error
            ? error
            : new GatewayLockError("failed to release state lock", error);
      }
      if (releaseError) {
        throw releaseError;
      }
    };
    return {
      ...configLock,
      stateDir: paths.stateDir,
      stateLockPath: stateLock.lockPath,
      releaseInTree,
      release: async () => {
        let releaseError: Error | undefined;
        try {
          await releaseInTree();
        } catch (error) {
          releaseError =
            error instanceof Error
              ? error
              : new GatewayLockError("failed to release in-tree gateway locks", error);
        }
        try {
          stateLifecycle.release();
        } catch (error) {
          releaseError ??=
            error instanceof Error
              ? error
              : new GatewayLockError("failed to release state lifecycle", error);
        }
        if (releaseError) {
          throw releaseError;
        }
      },
    };
  } catch (error) {
    await stateLock.release().catch(() => undefined);
    try {
      stateLifecycle.release();
    } catch {
      // Preserve the original lock acquisition failure.
    }
    throw error;
  }
}

async function acquireLockFile(
  opts: GatewayLockOptions & {
    configPath: string;
    lockPath: string;
    role: GatewayLockRole;
    stateDir: string;
    ownerId: string;
  },
): Promise<Omit<GatewayLockHandle, "releaseInTree" | "stateDir" | "stateLockPath">> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 0);
  const pollIntervalMs = resolvePositiveTimerTimeoutMs(
    opts.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const staleMs = resolveTimerTimeoutMs(opts.staleMs, DEFAULT_STALE_MS, 0);
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    (async (ms: number) =>
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const { configPath, lockPath, stateDir } = opts;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = now();
  let lastPayload: LockPayload | null = null;
  const buildPayload = (): LockPayload => {
    const startTime = (opts.readProcessStartTime ?? ((pid) => readProcessStartTime(pid, platform)))(
      process.pid,
    );
    return {
      pid: process.pid,
      ownerId: opts.ownerId,
      ...(opts.role === "gateway" ? { cronOwnerProjection: "dynamic-default-v1" as const } : {}),
      createdAt: resolveTimestampMsToIsoString(now()),
      configPath,
      stateDir,
      ...(typeof opts.port === "number" &&
      Number.isInteger(opts.port) &&
      opts.port > 0 &&
      opts.port <= 65_535
        ? { port: opts.port }
        : {}),
      ...(opts.role !== "gateway" ? { role: opts.role } : {}),
      ...(typeof startTime === "number" && Number.isFinite(startTime) ? { startTime } : {}),
    };
  };
  const shouldReclaim = (payload: LockPayload | null) =>
    shouldReclaimGatewayLock({
      lockPath,
      payload,
      staleMs,
      now,
      platform,
      readProcessCmdline: opts.readProcessCmdline,
      readProcessStartTime: opts.readProcessStartTime,
    });

  while (now() - startedAt < timeoutMs) {
    let coordinator: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator>;
    try {
      coordinator = tryAcquireExclusiveSqliteCoordinator(`${lockPath}.sqlite`);
    } catch (error) {
      throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, error);
    }
    if (!coordinator) {
      lastPayload = await readLockPayload(lockPath);
    } else {
      try {
        const lock = await GATEWAY_LOCKS.acquire(lockPath, {
          lockPath,
          staleMs,
          timeoutMs: 0,
          retry: { retries: 0 },
          staleRecovery: "remove-if-unchanged",
          payload: buildPayload,
          parsePayload: parseGatewayLockPayload,
          shouldReclaim: ({ payload }) => shouldReclaim(payload as LockPayload | null),
          shouldRemoveStaleLock: ({ payload }) => shouldReclaim(payload as LockPayload | null),
        });
        return {
          lockPath,
          configPath,
          release: async () => {
            let releaseError: unknown;
            try {
              coordinator.release();
            } catch (error) {
              releaseError = error;
            }
            await lock.release().catch((error: unknown) => {
              releaseError ??= error;
            });
            if (releaseError) {
              throw new GatewayLockError(
                `failed to release gateway lock at ${lockPath}`,
                releaseError,
              );
            }
          },
        };
      } catch (error) {
        coordinator.release();
        const code = (error as { code?: unknown }).code;
        if (code !== "file_lock_timeout" && code !== "file_lock_stale") {
          throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, error);
        }
        lastPayload = await readLockPayload(lockPath);
      }
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const ownerPid = lastPayload?.pid ? ` (pid ${lastPayload.pid})` : "";
  const owner =
    lastPayload?.role === "agent-embedded"
      ? `another embedded OpenClaw state writer is active${ownerPid}`
      : lastPayload?.role && lastPayload.role !== "gateway"
        ? `state directory is locked by ${lastPayload.role}${ownerPid}`
        : `gateway already running${ownerPid}`;
  throw new GatewayLockError(`${owner}; lock timeout after ${timeoutMs}ms`);
}
