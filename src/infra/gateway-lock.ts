// Coordinates gateway lock files, ports, and stale owner detection.
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { sha256HexPrefix } from "./crypto-digest.js";
import { isGatewayArgv, isOpenClawCommandArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { isSqliteLockError } from "./sqlite-transaction.js";
import {
  readWindowsProcessArgsSync,
  readWindowsProcessStartTimeSync,
} from "./windows-port-pids.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;

type LockPayload = {
  pid: number;
  createdAt: string;
  configPath: string;
  port?: number;
  role?: GatewayLockRole;
  stateDir?: string;
  startTime?: number;
};

const LockPayloadSchema = z.object({
  pid: z.number(),
  createdAt: z.string(),
  configPath: z.string(),
  port: z.number().int().min(1).max(65_535).optional(),
  role: z.enum(["gateway", "sqlite-maintenance"]).optional(),
  stateDir: z.string().optional(),
  startTime: z.number().optional(),
}) as z.ZodType<LockPayload>;

type GatewayLockHandle = {
  lockPath: string;
  stateLockPath: string;
  configPath: string;
  release: () => Promise<void>;
};

type GatewayLockRole = "gateway" | "sqlite-maintenance";

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

type GatewayLockCoordinator = {
  release: () => void;
};

function tryAcquireGatewayLockCoordinator(lockPath: string): GatewayLockCoordinator | null {
  const { DatabaseSync } = requireNodeSqlite();
  const coordinatorDb: DatabaseSync = new DatabaseSync(`${lockPath}.sqlite`);
  try {
    coordinatorDb.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    try {
      coordinatorDb.close();
    } catch {}
    if (isSqliteLockError(error)) {
      return null;
    }
    throw error;
  }

  return {
    release: () => {
      let releaseError: unknown;
      try {
        coordinatorDb.exec("ROLLBACK");
      } catch (error) {
        releaseError = error;
      }
      try {
        coordinatorDb.close();
      } catch (error) {
        releaseError ??= error;
      }
      if (releaseError) {
        throw new GatewayLockError("failed to release gateway lock coordinator", releaseError);
      }
    },
  };
}

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
  if (role === "sqlite-maintenance") {
    const args = readFn(pid);
    if (!args) {
      return "unknown";
    }
    return isOpenClawCommandArgv(args, "doctor") ? "alive" : "dead";
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

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return safeParseJsonWithSchema(LockPayloadSchema, raw);
  } catch {
    return null;
  }
}

function canonicalizeStateDir(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  try {
    return fsSync.realpathSync.native(resolved);
  } catch {
    const missingSegments: string[] = [];
    let current = resolved;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missingSegments.push(path.basename(current));
      current = parent;
      try {
        return path.join(fsSync.realpathSync.native(current), ...missingSegments.toReversed());
      } catch {
        // Keep walking so aliases in an existing ancestor still share one lock.
      }
    }
  }
}

function resolveGatewayLockPaths(env: NodeJS.ProcessEnv, lockDir = resolveGatewayLockDir()) {
  const resolvedStateDir = resolveStateDir(env);
  const stateDir = canonicalizeStateDir(resolvedStateDir);
  const configPath = resolveConfigPath(env, resolvedStateDir);
  const configHash = sha256HexPrefix(configPath, 8);
  const stateHash = sha256HexPrefix(stateDir, 8);
  return {
    configLockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateDir,
    stateLockPath: path.join(lockDir, `gateway.state.${stateHash}.lock`),
  };
}

export async function readActiveGatewayLockPort(
  opts: Pick<
    GatewayLockOptions,
    "env" | "lockDir" | "platform" | "readProcessCmdline" | "readProcessStartTime"
  > = {},
): Promise<number | undefined> {
  const env = opts.env ?? process.env;
  const { configLockPath, stateLockPath } = resolveGatewayLockPaths(env, opts.lockDir);
  const configPort = await readVerifiedGatewayLockPort(configLockPath, opts);
  return configPort ?? (await readVerifiedGatewayLockPort(stateLockPath, opts));
}

async function readVerifiedGatewayLockPort(
  lockPath: string,
  opts: Pick<GatewayLockOptions, "platform" | "readProcessCmdline" | "readProcessStartTime">,
): Promise<number | undefined> {
  const payload = await readLockPayload(lockPath);
  if (!payload?.port || payload.role === "sqlite-maintenance") {
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
  return ownerStatus === "alive" ? payload.port : undefined;
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
  const paths = resolveGatewayLockPaths(env, opts.lockDir);
  const stateLock = await acquireLockFile({
    ...opts,
    configPath: paths.configPath,
    env,
    lockPath: paths.stateLockPath,
    role,
    stateDir: paths.stateDir,
  });
  const shouldAcquireConfigLock =
    role === "sqlite-maintenance" || env.OPENCLAW_ALLOW_MULTI_GATEWAY !== "1";
  if (!shouldAcquireConfigLock) {
    return {
      ...stateLock,
      stateLockPath: stateLock.lockPath,
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
    });
    return {
      ...configLock,
      stateLockPath: stateLock.lockPath,
      release: async () => {
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
      },
    };
  } catch (error) {
    await stateLock.release().catch(() => undefined);
    throw error;
  }
}

async function acquireLockFile(
  opts: GatewayLockOptions & {
    configPath: string;
    lockPath: string;
    role: GatewayLockRole;
    stateDir: string;
  },
): Promise<Omit<GatewayLockHandle, "stateLockPath">> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 0);
  const pollIntervalMs = resolvePositiveTimerTimeoutMs(
    opts.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const staleMs = resolveTimerTimeoutMs(opts.staleMs, DEFAULT_STALE_MS, 0);
  const platform = opts.platform ?? process.platform;
  const port = opts.port;
  const role = opts.role;
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

  while (now() - startedAt < timeoutMs) {
    let coordinator: GatewayLockCoordinator | null;
    try {
      coordinator = tryAcquireGatewayLockCoordinator(lockPath);
    } catch (error) {
      throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, error);
    }

    if (!coordinator) {
      lastPayload = await readLockPayload(lockPath);
    } else {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let acquisitionError: unknown;
      let waitForOwner = false;
      try {
        while (!handle && !waitForOwner) {
          let candidateHandle: Awaited<ReturnType<typeof fs.open>>;
          try {
            candidateHandle = await fs.open(lockPath, "wx");
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code !== "EEXIST") {
              throw error;
            }

            lastPayload = await readLockPayload(lockPath);
            const ownerPid = lastPayload?.pid;
            const ownerStatus = ownerPid
              ? await resolveGatewayOwnerStatus(
                  ownerPid,
                  lastPayload,
                  platform,
                  opts.readProcessCmdline,
                  opts.readProcessStartTime,
                )
              : "unknown";
            if (ownerStatus === "dead" && ownerPid) {
              await fs.rm(lockPath, { force: true });
              continue;
            }
            if (ownerStatus !== "alive") {
              let stale = false;
              if (lastPayload?.createdAt) {
                const createdAt = Date.parse(lastPayload.createdAt);
                stale = Number.isFinite(createdAt) ? now() - createdAt > staleMs : false;
              }
              if (!stale) {
                try {
                  const st = await fs.stat(lockPath);
                  stale = now() - st.mtimeMs > staleMs;
                } catch {
                  // On Windows or locked filesystems we may be unable to stat the
                  // lock file even though the existing gateway is still healthy.
                  // Treat the lock as non-stale so we keep waiting instead of
                  // forcefully removing another gateway's lock.
                  stale = false;
                }
              }
              if (stale) {
                await fs.rm(lockPath, { force: true });
                continue;
              }
            }
            waitForOwner = true;
            continue;
          }

          try {
            const startTime = (
              opts.readProcessStartTime ?? ((pid) => readProcessStartTime(pid, platform))
            )(process.pid);
            const payload: LockPayload = {
              pid: process.pid,
              createdAt: resolveTimestampMsToIsoString(now()),
              configPath,
              stateDir,
            };
            if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535) {
              payload.port = port;
            }
            if (role !== "gateway") {
              payload.role = role;
            }
            if (typeof startTime === "number" && Number.isFinite(startTime)) {
              payload.startTime = startTime;
            }
            await candidateHandle.writeFile(JSON.stringify(payload), "utf8");
            handle = candidateHandle;
          } catch (error) {
            // Acquisition owns both resources until the release callback exists.
            // Unwind them if payload preparation fails before ownership transfers.
            await candidateHandle.close().catch(() => undefined);
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        acquisitionError = error;
      }

      if (handle) {
        return {
          lockPath,
          configPath,
          release: async () => {
            let releaseError: unknown;
            try {
              await handle.close();
            } catch (error) {
              releaseError = error;
            }
            try {
              await fs.rm(lockPath, { force: true });
            } catch (error) {
              releaseError ??= error;
            }
            try {
              coordinator.release();
            } catch (error) {
              releaseError ??= error;
            }
            if (releaseError) {
              throw new GatewayLockError(
                `failed to release gateway lock at ${lockPath}`,
                releaseError,
              );
            }
          },
        };
      }

      try {
        coordinator.release();
      } catch (error) {
        acquisitionError ??= error;
      }
      if (acquisitionError) {
        throw new GatewayLockError(
          `failed to acquire gateway lock at ${lockPath}`,
          acquisitionError,
        );
      }
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const owner = lastPayload?.pid ? ` (pid ${lastPayload.pid})` : "";
  throw new GatewayLockError(`gateway already running${owner}; lock timeout after ${timeoutMs}ms`);
}
