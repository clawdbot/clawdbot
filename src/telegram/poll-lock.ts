import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;

type LockPayload = {
  pid: number;
  createdAt: string;
  accountId: string;
  tokenHash: string;
  startTime?: number;
};

export type TelegramPollLockHandle = {
  lockPath: string;
  unitKey: string;
  release: () => Promise<void>;
};

export class TelegramPollLockError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TelegramPollLockError";
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseProcCmdline(raw: string): string[] {
  return raw
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readLinuxCmdline(pid: number): string[] | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return parseProcCmdline(raw);
  } catch {
    return null;
  }
}

function readLinuxStartTime(pid: number): number | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) return null;
    const rest = raw.slice(closeParen + 1).trim();
    const fields = rest.split(/\s+/);
    const startTime = Number.parseInt(fields[19] ?? "", 10);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

type LockOwnerStatus = "alive" | "dead" | "unknown";

function resolveOwnerStatus(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
): LockOwnerStatus {
  if (!isAlive(pid)) return "dead";
  if (platform !== "linux") return "alive";

  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = readLinuxStartTime(pid);
    if (currentStartTime == null) return "unknown";
    return currentStartTime === payloadStartTime ? "alive" : "dead";
  }

  const args = readLinuxCmdline(pid);
  if (!args) return "unknown";
  // Best-effort: still running, but not necessarily a poller; treat unknown as alive unless stale.
  return args.length > 0 ? "alive" : "unknown";
}

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) return "default";
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function hashToken(token: string) {
  return createHash("sha1").update(token).digest("hex").slice(0, 10);
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.createdAt !== "string") return null;
    if (typeof parsed.accountId !== "string") return null;
    if (typeof parsed.tokenHash !== "string") return null;
    const startTime = typeof parsed.startTime === "number" ? parsed.startTime : undefined;
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      accountId: parsed.accountId,
      tokenHash: parsed.tokenHash,
      startTime,
    };
  } catch {
    return null;
  }
}

function resolveTelegramPollLockPath(params: {
  accountId?: string;
  token: string;
  env: NodeJS.ProcessEnv;
}) {
  const stateDir = resolveStateDir(params.env, os.homedir);
  const telegramDir = path.join(stateDir, "telegram");
  const normalized = normalizeAccountId(params.accountId);
  const tokenHash = hashToken(params.token);
  const unitKey = `${normalized}:${tokenHash}`;
  const lockPath = path.join(telegramDir, `poll-lock.${normalized}.${tokenHash}.lock`);
  return { lockPath, unitKey, tokenHash };
}

export async function acquireTelegramPollLock(opts: {
  token: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  platform?: NodeJS.Platform;
}): Promise<TelegramPollLockHandle> {
  const env = opts.env ?? process.env;
  if (env.CLAWDBOT_ALLOW_MULTI_TELEGRAM_POLL === "1") {
    return {
      lockPath: "",
      unitKey: "disabled",
      release: async () => undefined,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const platform = opts.platform ?? process.platform;

  const { lockPath, unitKey, tokenHash } = resolveTelegramPollLockPath({
    accountId: opts.accountId,
    token: opts.token,
    env,
  });
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const startedAt = Date.now();
  let lastPayload: LockPayload | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const startTime = platform === "linux" ? readLinuxStartTime(process.pid) : null;
      const payload: LockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        accountId: normalizeAccountId(opts.accountId),
        tokenHash,
      };
      if (typeof startTime === "number" && Number.isFinite(startTime)) {
        payload.startTime = startTime;
      }
      await handle.writeFile(JSON.stringify(payload), "utf8");
      return {
        lockPath,
        unitKey,
        release: async () => {
          await handle.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw new TelegramPollLockError(`failed to acquire telegram poll lock at ${lockPath}`, err);
      }

      lastPayload = await readLockPayload(lockPath);
      const ownerPid = lastPayload?.pid;
      const ownerStatus = ownerPid
        ? resolveOwnerStatus(ownerPid, lastPayload, platform)
        : "unknown";
      if (ownerStatus === "dead" && ownerPid) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (ownerStatus !== "alive") {
        let stale = false;
        if (lastPayload?.createdAt) {
          const createdAt = Date.parse(lastPayload.createdAt);
          stale = Number.isFinite(createdAt) ? Date.now() - createdAt > staleMs : false;
        }
        if (!stale) {
          try {
            const st = await fs.stat(lockPath);
            stale = Date.now() - st.mtimeMs > staleMs;
          } catch {
            stale = true;
          }
        }
        if (stale) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  const owner = lastPayload?.pid ? `pid=${lastPayload.pid}` : "unknown owner";
  throw new TelegramPollLockError(`telegram poll lock timeout (${owner}) for ${unitKey}`);
}
