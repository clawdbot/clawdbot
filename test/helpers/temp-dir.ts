// Test temp directory helper creates and cleans up temporary directories.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Synchronous temporary directory helpers for tests.

type TempDirCollection = string[] | Set<string>;
type RegisterTempDirCleanup = (cleanup: () => void) => unknown;

const canonicalSystemTempRoots = new Map<string, string>();

function resolveCanonicalSystemTempRoot(): string {
  const rawRoot = os.tmpdir();
  const cachedRoot = canonicalSystemTempRoots.get(rawRoot);
  if (cachedRoot !== undefined) {
    return cachedRoot;
  }
  const canonicalRoot = fs.realpathSync(rawRoot);
  canonicalSystemTempRoots.set(rawRoot, canonicalRoot);
  return canonicalRoot;
}

interface TestTempDirTracker {
  readonly dirs: ReadonlySet<string>;
  make(prefix: string, root?: string): string;
  cleanup(this: void): void;
}

interface AutoCleanupTempDirTracker {
  readonly dirs: ReadonlySet<string>;
  make(prefix: string, root?: string): string;
}

/** Create a temp dir and register it in an array or set for cleanup. */
export function makeTempDir(tempDirs: TempDirCollection, prefix: string, root?: string): string {
  const tempRoot = root ?? resolveCanonicalSystemTempRoot();
  const dir = fs.mkdtempSync(path.join(tempRoot, prefix));
  if (Array.isArray(tempDirs)) {
    tempDirs.push(dir);
  } else {
    tempDirs.add(dir);
  }
  return dir;
}

/** Remove tracked directories, retaining failed removals for cleanup retry. */
export function cleanupTempDirs(tempDirs: TempDirCollection): void {
  // Successful releases mutate the tracker; walk the original ownership snapshot.
  const dirs = [...tempDirs];
  const errors: unknown[] = [];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      if (Array.isArray(tempDirs)) {
        tempDirs.splice(tempDirs.indexOf(dir), 1);
      } else {
        tempDirs.delete(dir);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Test temporary directory cleanup failed");
  }
}

export function createTempDirTracker(): TestTempDirTracker {
  const dirs = new Set<string>();
  return {
    dirs,
    make(prefix: string, root?: string): string {
      return makeTempDir(dirs, prefix, root);
    },
    cleanup(this: void): void {
      cleanupTempDirs(dirs);
    },
  };
}

/** Create a temp dir tracker that Vitest cleans up after each test. */
export function useAutoCleanupTempDirTracker(
  registerCleanup: RegisterTempDirCleanup,
): AutoCleanupTempDirTracker {
  const tracker = createTempDirTracker();
  registerCleanup(tracker.cleanup);
  return tracker;
}
