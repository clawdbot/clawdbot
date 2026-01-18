import fs from "node:fs/promises";
import path from "node:path";

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
};

const HELD_LOCKS = new Map<string, HeldLock>();

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.createdAt !== "string") return null;
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
}): Promise<{
  release: () => Promise<void>;
}> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? 30 * 60 * 1000;
  const sessionFile = params.sessionFile;
  const lockPath = `${sessionFile}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const held = HELD_LOCKS.get(sessionFile);
  if (held) {
    held.count += 1;
    return {
      release: async () => {
        const current = HELD_LOCKS.get(sessionFile);
        if (!current) return;
        current.count -= 1;
        if (current.count > 0) return;
        HELD_LOCKS.delete(sessionFile);
        await current.handle.close();
        await fs.rm(current.lockPath, { force: true });
      },
    };
  }

  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      HELD_LOCKS.set(sessionFile, { count: 1, handle, lockPath });
      return {
        release: async () => {
          const current = HELD_LOCKS.get(sessionFile);
          if (!current) return;
          current.count -= 1;
          if (current.count > 0) return;
          HELD_LOCKS.delete(sessionFile);
          await current.handle.close();
          await fs.rm(current.lockPath, { force: true });
        },
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") throw err;
      const payload = await readLockPayload(lockPath);
      const createdAt = payload?.createdAt ? Date.parse(payload.createdAt) : NaN;
      const stale = !Number.isFinite(createdAt) || Date.now() - createdAt > staleMs;
      const alive = payload?.pid ? isAlive(payload.pid) : false;
      if (stale || !alive) {
        await fs.rm(lockPath, { force: true });
        continue;
      }

      const delay = Math.min(1000, 50 * attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const payload = await readLockPayload(lockPath);
  const owner = payload?.pid ? `pid=${payload.pid}` : "unknown";
  throw new Error(`session file locked (timeout ${timeoutMs}ms): ${owner} ${lockPath}`);
}
