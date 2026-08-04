/** Doctor-only inspection and repair for retired `.jsonl.lock` sidecars. */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import { createFileLockManager } from "../infra/file-lock-manager.js";
import { readGatewayProcessArgsSync } from "../infra/gateway-processes.js";
import {
  inspectSessionLockFileContention,
  parseSessionLockFilePayload,
  type SessionLockFileInspection,
  type SessionLockFilePayload,
  type SessionLockOwnerProcessArgsReader,
} from "../infra/session-lock-file-inspection.js";

export type SessionLockInspection = SessionLockFileInspection & {
  lockPath: string;
  removable: boolean;
  removed: boolean;
};

export type { SessionLockOwnerProcessArgsReader };

const LOCK_RECLAIMS = createFileLockManager("openclaw.doctor.session-lock-reclaim");
const MALFORMED_OWNER_GRACE_MS = 30_000;

async function readPayload(lockPath: string): Promise<SessionLockFilePayload | null> {
  try {
    return parseSessionLockFilePayload(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function reclaimIfUnchanged(params: {
  lockPath: string;
  staleMs: number;
  nowMs: number;
  readOwnerProcessArgs: SessionLockOwnerProcessArgsReader;
}): Promise<boolean> {
  const approve = async (payload: unknown) =>
    (
      await inspectSessionLockFileContention({
        lockPath: params.lockPath,
        payload: payload as SessionLockFilePayload | null,
        staleMs: params.staleMs,
        nowMs: params.nowMs,
        orphanGraceMs: MALFORMED_OWNER_GRACE_MS,
        readOwnerProcessArgs: params.readOwnerProcessArgs,
      })
    ).removable;
  try {
    const lock = await LOCK_RECLAIMS.acquire(params.lockPath, {
      lockPath: params.lockPath,
      staleMs: params.staleMs,
      timeoutMs: 0,
      retry: { retries: 0 },
      staleRecovery: "remove-if-unchanged",
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      parsePayload: parseSessionLockFilePayload,
      shouldReclaim: ({ payload }) => approve(payload),
      shouldRemoveStaleLock: ({ payload }) => approve(payload),
    });
    await lock.release();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "file_lock_timeout" || code === "file_lock_stale") {
      return false;
    }
    throw error;
  }
}

export async function cleanStaleSessionLockFiles(params: {
  sessionsDir: string;
  staleMs: number;
  removeStale?: boolean;
  nowMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<{ locks: SessionLockInspection[]; cleaned: SessionLockInspection[] }> {
  const sessionsDir = path.resolve(params.sessionsDir);
  const nowMs = params.nowMs ?? Date.now();
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { locks: [], cleaned: [] };
    }
    throw error;
  }
  const ownerArgs = params.readOwnerProcessArgs ?? readGatewayProcessArgsSync;
  const argsByPid = new Map<number, string[] | null>();
  const readOwnerProcessArgs = (pid: number) => {
    if (!argsByPid.has(pid)) {
      try {
        argsByPid.set(pid, ownerArgs(pid));
      } catch {
        // Transient process inspection failures remain retryable for a later lock.
        return null;
      }
    }
    return argsByPid.get(pid) ?? null;
  };
  const locks: SessionLockInspection[] = [];
  const cleaned: SessionLockInspection[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.name.endsWith(".jsonl.lock"))
    .toSorted((left, right) => left.name.localeCompare(right.name))) {
    await scheduler.yield();
    const lockPath = path.join(sessionsDir, entry.name);
    const { inspection: inspected, removable } = await inspectSessionLockFileContention({
      lockPath,
      payload: await readPayload(lockPath),
      staleMs: params.staleMs,
      nowMs,
      orphanGraceMs: MALFORMED_OWNER_GRACE_MS,
      readOwnerProcessArgs,
    });
    const lock = { lockPath, ...inspected, removable, removed: false };
    if (params.removeStale !== false && removable) {
      lock.removed = await reclaimIfUnchanged({
        lockPath,
        staleMs: params.staleMs,
        nowMs,
        readOwnerProcessArgs,
      });
      if (lock.removed) {
        cleaned.push(lock);
      }
    }
    locks.push(lock);
  }
  return { locks, cleaned };
}
