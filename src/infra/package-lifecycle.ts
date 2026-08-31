import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";

const PACKAGE_LIFECYCLE_LOCK_RELATIVE_PATH = ".openclaw-lifecycle-lock";
const DEFAULT_PACKAGE_LIFECYCLE_SCRIPT_TIMEOUT_MS = 20 * 60_000;
const PACKAGE_LIFECYCLE_LOCK_POLL_MS = 100;
const PACKAGE_LIFECYCLE_LOCK_RECOVERY_GRACE_MS = 20 * 60_000;

export type PackageLifecycleScript = Readonly<{
  name: "preinstall" | "postinstall";
  relativePath: string;
}>;

const PACKAGE_LIFECYCLE_SCRIPTS: readonly PackageLifecycleScript[] = [
  {
    name: "preinstall",
    relativePath: path.join("scripts", "preinstall-package-manager-warning.mjs"),
  },
  {
    name: "postinstall",
    relativePath: path.join("scripts", "postinstall-bundled-plugins.mjs"),
  },
];
function resolveLifecycleBudgetMs(scriptTimeoutMs: number): number {
  return scriptTimeoutMs * PACKAGE_LIFECYCLE_SCRIPTS.length;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function resolveLifecyclePaths(packageRoot: string) {
  return {
    pending: path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
    legacyGuard: path.join(packageRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
    lock: path.join(packageRoot, PACKAGE_LIFECYCLE_LOCK_RELATIVE_PATH),
  };
}

async function isPackageLifecyclePending(paths: ReturnType<typeof resolveLifecyclePaths>) {
  return (await pathExists(paths.pending)) || (await pathExists(paths.legacyGuard));
}

async function ensurePendingMarker(markerPath: string): Promise<void> {
  try {
    await fs.writeFile(markerPath, "pending\n", { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
}

async function acquireLifecycleLock(
  paths: ReturnType<typeof resolveLifecyclePaths>,
  scriptTimeoutMs: number,
) {
  let waitDeadline =
    Date.now() +
    resolveLifecycleBudgetMs(scriptTimeoutMs) +
    PACKAGE_LIFECYCLE_LOCK_RECOVERY_GRACE_MS;
  while (await isPackageLifecyclePending(paths)) {
    try {
      await fs.mkdir(paths.lock);
      const ownerDeadline = new Date(Date.now() + resolveLifecycleBudgetMs(scriptTimeoutMs));
      try {
        // The directory mtime carries the owner's full script budget across processes.
        // Recovery grace also protects the short mkdir-to-utimes ownership window.
        await fs.utimes(paths.lock, ownerDeadline, ownerDeadline);
      } catch (error) {
        await fs.rmdir(paths.lock).catch(() => undefined);
        throw error;
      }
      return async () => await fs.rmdir(paths.lock).catch(() => undefined);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const stat = await fs.stat(paths.lock).catch(() => null);
      if (stat) {
        const staleAt = stat.mtimeMs + PACKAGE_LIFECYCLE_LOCK_RECOVERY_GRACE_MS;
        waitDeadline = Math.max(waitDeadline, staleAt);
        if (Date.now() >= staleAt) {
          await fs.rmdir(paths.lock).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= waitDeadline) {
        throw new Error("timed out waiting for another OpenClaw package lifecycle", {
          cause: error,
        });
      }
      await new Promise((resolve) => {
        setTimeout(resolve, PACKAGE_LIFECYCLE_LOCK_POLL_MS);
      });
    }
  }
  return null;
}

function runPackageLifecycleScript(
  packageRoot: string,
  script: PackageLifecycleScript,
  timeoutMs: number,
): void {
  const scriptPath = path.join(packageRoot, script.relativePath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
    timeout: timeoutMs,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `OpenClaw package ${script.name} failed${result.signal ? ` with ${result.signal}` : ` with exit code ${result.status ?? "unknown"}`}`,
    );
  }
}

export async function completePendingPackageLifecycle(params: {
  packageRoot: string;
  runScript?: (script: PackageLifecycleScript) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<boolean> {
  const packageRoot = path.resolve(params.packageRoot);
  const scriptTimeoutMs = params.timeoutMs ?? DEFAULT_PACKAGE_LIFECYCLE_SCRIPT_TIMEOUT_MS;
  const paths = resolveLifecyclePaths(packageRoot);
  if (!(await isPackageLifecyclePending(paths))) {
    return false;
  }

  const releaseLock = await acquireLifecycleLock(paths, scriptTimeoutMs);
  if (!releaseLock) {
    return false;
  }
  try {
    if (!(await isPackageLifecyclePending(paths))) {
      return false;
    }
    // Promote the shipped 2026.8.1 dist guard before preinstall removes it.
    // Postinstall alone clears the canonical marker after all lifecycle work succeeds.
    await ensurePendingMarker(paths.pending);
    const runScript =
      params.runScript ??
      ((script) => runPackageLifecycleScript(packageRoot, script, scriptTimeoutMs));
    for (const script of PACKAGE_LIFECYCLE_SCRIPTS) {
      await runScript(script);
    }
    if (await isPackageLifecyclePending(paths)) {
      throw new Error("OpenClaw package postinstall did not complete its lifecycle marker");
    }
    return true;
  } catch (error) {
    await ensurePendingMarker(paths.pending).catch(() => undefined);
    throw error;
  } finally {
    await releaseLock();
  }
}
