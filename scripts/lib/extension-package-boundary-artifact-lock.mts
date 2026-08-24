import fs from "node:fs";
import path from "node:path";

const LOCK_POLL_MS = 500;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const OWNER_WRITE_GRACE_MS = 30 * 1000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

type LockOwner = { pid?: unknown };

function isProcessAlive(pid: unknown) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function shouldReclaimLock(lockDir: string, ownerPath: string) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as LockOwner;
    return !isProcessAlive(owner.pid);
  } catch {
    try {
      return Date.now() - fs.statSync(lockDir).mtimeMs >= OWNER_WRITE_GRACE_MS;
    } catch {
      return true;
    }
  }
}

export function acquireExtensionPackageBoundaryArtifactLockSync(rootDir: string) {
  // The generated declarations live in this checkout. Keeping ownership beside
  // them prevents same-worktree writers without coupling independent worktrees.
  const lockDir = path.join(rootDir, "dist", ".extension-package-boundary-artifacts.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const startedAt = Date.now();
  let reportedWait = false;

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        fs.rmSync(lockDir, { force: true, recursive: true });
      };
      process.once("exit", release);
      return () => {
        process.off("exit", release);
        release();
      };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      if (shouldReclaimLock(lockDir, ownerPath)) {
        fs.rmSync(lockDir, { force: true, recursive: true });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for plugin package-boundary artifacts in ${rootDir}`, {
          cause: error,
        });
      }
      if (!reportedWait) {
        console.error("[plugin package-boundary artifacts] waiting for the current writer...");
        reportedWait = true;
      }
      Atomics.wait(SLEEP_BUFFER, 0, 0, LOCK_POLL_MS);
    }
  }
}
