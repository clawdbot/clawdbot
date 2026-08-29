// Checkout-local ownership for build outputs, declaration preparation and consumers.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";

export const DIST_ARTIFACT_LOCK_PATH = ".artifacts/dist-artifacts.lock";
const LOCK_POLL_MS = 500;

function lockPath(rootDir: string) {
  return path.join(rootDir, DIST_ARTIFACT_LOCK_PATH);
}

function hasUnjoinedWork(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("processTreeState" in error && error.processTreeState !== "terminated") {
    return true;
  }
  if (error instanceof AggregateError && error.errors.some(hasUnjoinedWork)) {
    return true;
  }
  return "cause" in error && hasUnjoinedWork(error.cause);
}

export function retainUnjoinedDistArtifactWork(rootDir: string, error: unknown) {
  if (hasUnjoinedWork(error)) {
    fs.writeFileSync(path.join(lockPath(rootDir), "unjoined"), "Child cleanup was not verified.\n");
  }
}

export async function runOwnedDistArtifactEntry<T>(run: () => Promise<T>) {
  const directory = lockPath(process.cwd());
  const claim = path.join(directory, `child-${process.pid}`);
  // A killed nested wrapper cannot certify its detached compiler has joined.
  // Its surviving claim keeps the outer owner from releasing on leader exit.
  fs.writeFileSync(claim, "Awaiting child completion.\n", { flag: "wx" });
  try {
    return await run();
  } catch (error) {
    retainUnjoinedDistArtifactWork(process.cwd(), error);
    throw error;
  } finally {
    fs.unlinkSync(claim);
  }
}

/** The callback must join every writer/reader before returning, including on failure. */
export async function withDistArtifactOwnership<T>(rootDir: string, run: () => Promise<T>) {
  const directory = lockPath(rootDir);
  fs.mkdirSync(directory, { recursive: true });
  const ownerPath = path.join(directory, "owner.json");
  let reportedWait = false;
  let lock;
  try {
    lock = await acquireFileLock(ownerPath, {
      lockPath: ownerPath,
      // Bounded-root fs-safe locks retain their file on process exit. Only the
      // explicit release after our child joins may remove this owner record.
      lockRoot: await openLockRoot(directory),
      payload: () => ({ pid: process.pid, startedAt: new Date().toISOString() }),
      timeoutMs: Number.POSITIVE_INFINITY,
      retry: { minTimeout: LOCK_POLL_MS, maxTimeout: LOCK_POLL_MS, factor: 1 },
      staleRecovery: "fail-closed",
      shouldReclaim: ({ payload }) => {
        // Return stale rather than throwing: fs-safe rechecks the observed owner
        // before failing closed, so normal release/exit cannot reject its successor.
        // PID death is diagnostic only; fail-closed never removes the lock.
        const pid = payload && typeof payload === "object" && "pid" in payload ? payload.pid : null;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
          return true;
        }
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        if (fs.existsSync(path.join(directory, "unjoined"))) {
          return true;
        }
        if (!reportedWait) {
          console.error(`[dist artifacts] waiting for checkout ownership: ${directory}`);
          reportedWait = true;
        }
        return false;
      },
    });
  } catch (error) {
    throw new Error(
      `Could not acquire ${directory}. Inspect owner.json and verify all associated build/check processes, including detached descendants, have stopped before manually removing this lock directory and retrying. PID death alone is not sufficient.`,
      { cause: error },
    );
  }
  // PID death and age cannot prove detached children stopped. Abrupt exits retain
  // ownership; only joined work releases it, never a signal/exit hook or stale timer.
  try {
    return await run();
  } catch (error) {
    retainUnjoinedDistArtifactWork(rootDir, error);
    throw error;
  } finally {
    if (
      fs.readdirSync(directory).some((name) => name === "unjoined" || name.startsWith("child-"))
    ) {
      console.error(`[dist artifacts] child cleanup unverified; retained ${directory}`);
    } else {
      await lock.release();
    }
  }
}

/**
 * An owning orchestrator calls the same implementation in a separately sized Node
 * process. It joins that child without re-entering the standalone CLI's lock.
 */
export function distArtifactEntryArgs(script: string, entry: string, args: string[] = []) {
  return [
    "--import",
    new URL("../tsx.mjs", import.meta.url).href,
    "--input-type=module",
    "--eval",
    [
      `const { runOwnedDistArtifactEntry } = await import(${JSON.stringify(import.meta.url)});`,
      `process.exitCode = (await runOwnedDistArtifactEntry(async () => {`,
      `const { ${entry} } = await import(${JSON.stringify(pathToFileURL(path.resolve(script)).href)});`,
      `return await ${entry}(${JSON.stringify(args)}); })) ?? 0;`,
    ].join("\n"),
  ];
}
