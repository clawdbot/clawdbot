import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";

const PACKAGE_LIFECYCLE_LOCK_RELATIVE_PATH = ".openclaw-lifecycle-lock";
const PACKAGE_LIFECYCLE_TIMEOUT_MS = 20 * 60_000;
const PACKAGE_LIFECYCLE_LOCK_POLL_MS = 100;

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
// Each script can consume its full timeout. Keep one extra window so scheduler and
// filesystem overhead cannot make a live owner look stale between scripts.
const PACKAGE_LIFECYCLE_LOCK_STALE_MS =
  PACKAGE_LIFECYCLE_TIMEOUT_MS * (PACKAGE_LIFECYCLE_SCRIPTS.length + 1);

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

async function acquireLifecycleLock(paths: ReturnType<typeof resolveLifecyclePaths>) {
  const deadline = Date.now() + PACKAGE_LIFECYCLE_TIMEOUT_MS;
  while (await isPackageLifecyclePending(paths)) {
    try {
      await fs.mkdir(paths.lock);
      return async () => await fs.rmdir(paths.lock).catch(() => undefined);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const stat = await fs.stat(paths.lock).catch(() => null);
      // Lifecycle subprocesses share this deadline. An older lock cannot still own live work.
      if (stat && Date.now() - stat.mtimeMs >= PACKAGE_LIFECYCLE_LOCK_STALE_MS) {
        await fs.rmdir(paths.lock).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
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

function runPackageLifecycleScript(packageRoot: string, script: PackageLifecycleScript): void {
  const scriptPath = path.join(packageRoot, script.relativePath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
    timeout: PACKAGE_LIFECYCLE_TIMEOUT_MS,
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
}): Promise<boolean> {
  const packageRoot = path.resolve(params.packageRoot);
  const paths = resolveLifecyclePaths(packageRoot);
  if (!(await isPackageLifecyclePending(paths))) {
    return false;
  }

  const releaseLock = await acquireLifecycleLock(paths);
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
      params.runScript ?? ((script) => runPackageLifecycleScript(packageRoot, script));
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
