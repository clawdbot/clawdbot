import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { isGatewayArgv, parseProcCmdline, parseWindowsCmdline } from "./gateway-process-argv.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1000;

type LockPayload = {
  pid: number;
  createdAt: string;
  configPath: string;
  startTime?: number;
};

const LockPayloadSchema = z.object({
  pid: z.number(),
  createdAt: z.string(),
  configPath: z.string(),
  startTime: z.number().optional(),
}) as z.ZodType<LockPayload>;

type GatewayLockHandle = {
  lockPath: string;
  configPath: string;
  release: () => Promise<void>;
};

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
  /** Override process command-line reader (testing seam). */
  readProcessCmdline?: (pid: number) => string[] | null;
};

export class GatewayLockError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
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

/**
 * Read the command line of a Windows process via `wmic`.
 * Returns an argv-style array, or null when the lookup fails (process gone,
 * `wmic` missing/deprecated, timeout, etc.).
 */
function readWindowsCmdline(pid: number): string[] | null {
  try {
    // Omit `encoding` so execFileSync returns a Buffer — wmic emits UTF-16LE
    // (with BOM) on most Windows 10/11 builds, which would be garbled as UTF-8.
    const buf = execFileSync(
      "wmic",
      ["process", "where", `processid=${pid}`, "get", "CommandLine", "/value"],
      { timeout: CMDLINE_EXEC_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ) as Buffer;
    const raw =
      buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
        ? buf.toString("utf16le")
        : buf.toString("utf8");
    const match = raw.match(/CommandLine=(.+)/);
    if (!match) {
      return null;
    }
    return parseWindowsCmdline(match[1].trim());
  } catch {
    return null;
  }
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

function readLinuxStartTime(pid: number): number | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const rest = raw.slice(closeParen + 1).trim();
    const fields = rest.split(/\s+/);
    const startTime = Number.parseInt(fields[19] ?? "", 10);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function checkPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Conservative for liveness checks: timeout usually means no responsive
      // local listener, so treat the lock owner as stale.
      finish(true);
    }, DEFAULT_PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(true);
    });
  });
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
  port: number | undefined,
  readCmdline?: (pid: number) => string[] | null,
): Promise<LockOwnerStatus> {
  if (port != null) {
    const portFree = await checkPortFree(port);
    if (portFree) {
      return "dead";
    }
  }

  if (!isPidAlive(pid)) {
    return "dead";
  }

  // On Linux, an extra start-time comparison catches PID recycling even when
  // the replacement process also looks like a gateway (same argv shape).
  if (platform === "linux") {
    const payloadStartTime = payload?.startTime;
    if (Number.isFinite(payloadStartTime)) {
      const currentStartTime = readLinuxStartTime(pid);
      if (currentStartTime == null) {
        return "unknown";
      }
      return currentStartTime === payloadStartTime ? "alive" : "dead";
    }
  }

  const readFn = readCmdline ?? ((p: number) => defaultReadProcessCmdline(p, platform));
  const args = readFn(pid);
  if (!args) {
    // Cmdline reader unavailable or failed. On Linux legacy locks (no
    // start-time), "unknown" lets the stale-lock heuristic eventually reclaim
    // very old locks. On win32/darwin/other, conservatively assume "alive" to
    // preserve single-instance guarantees when wmic/ps is unavailable.
    return platform === "linux" ? "unknown" : "alive";
  }
  return isGatewayArgv(args) ? "alive" : "dead";
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return safeParseJsonWithSchema(LockPayloadSchema, raw);
  } catch {
    return null;
  }
}

function resolveGatewayLockPath(env: NodeJS.ProcessEnv, lockDir = resolveGatewayLockDir()) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockPath = path.join(lockDir, `gateway.${hash}.lock`);
  return { lockPath, configPath };
}

export async function acquireGatewayLock(
  opts: GatewayLockOptions = {},
): Promise<GatewayLockHandle | null> {
  const env = opts.env ?? process.env;
  const allowInTests = opts.allowInTests === true;
  if (
    env.OPENCLAW_ALLOW_MULTI_GATEWAY === "1" ||
    (!allowInTests && (env.VITEST || env.NODE_ENV === "test"))
  ) {
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const platform = opts.platform ?? process.platform;
  const port = opts.port;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
  const { lockPath, configPath } = resolveGatewayLockPath(env, opts.lockDir);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = now();
  let lastPayload: LockPayload | null = null;

  while (now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const startTime = platform === "linux" ? readLinuxStartTime(process.pid) : null;
      const payload: LockPayload = {
        pid: process.pid,
        createdAt: new Date(now()).toISOString(),
        configPath,
      };
      if (typeof startTime === "number" && Number.isFinite(startTime)) {
        payload.startTime = startTime;
      }
      await handle.writeFile(JSON.stringify(payload), "utf8");
      return {
        lockPath,
        configPath,
        release: async () => {
          await handle.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw new GatewayLockError(`failed to acquire gateway lock at ${lockPath}`, err);
      }

      lastPayload = await readLockPayload(lockPath);
      const ownerPid = lastPayload?.pid;
      const ownerStatus = ownerPid
        ? await resolveGatewayOwnerStatus(
            ownerPid,
            lastPayload,
            platform,
            port,
            opts.readProcessCmdline,
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

      await sleep(pollIntervalMs);
    }
  }

  const owner = lastPayload?.pid ? ` (pid ${lastPayload.pid})` : "";
  throw new GatewayLockError(`gateway already running${owner}; lock timeout after ${timeoutMs}ms`);
}
