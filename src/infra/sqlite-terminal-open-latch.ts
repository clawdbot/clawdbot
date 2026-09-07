import path from "node:path";
import { isPathInside } from "./path-guards.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "./sqlite-file-generation.js";

type TerminalOpenFailure = {
  error: Error;
  generation?: SqliteFileGeneration;
};

function generationMatchesPath(pathname: string, expected: SqliteFileGeneration): boolean {
  try {
    return sameSqliteFileGeneration(expected, readStableSqliteFileGeneration(pathname));
  } catch {
    return false;
  }
}

/**
 * Per-path latch for terminal database-open failures (newer schema, proven
 * corruption). Recording quarantines the path: any live handle is closed and
 * every later open fails fast until doctor repairs the file and clears it.
 */
export function createSqliteTerminalOpenLatch(options: {
  closeByPath: (pathname: string) => void;
}) {
  const failures = new Map<string, TerminalOpenFailure>();

  return {
    get: (pathname: string): Error | undefined => {
      const resolvedPath = path.resolve(pathname);
      const failure = failures.get(resolvedPath);
      if (!failure) {
        return undefined;
      }
      if (failure.generation && !generationMatchesPath(resolvedPath, failure.generation)) {
        failures.delete(resolvedPath);
        return undefined;
      }
      return failure.error;
    },
    record: (pathname: string, error: Error, generation?: SqliteFileGeneration): boolean => {
      const resolvedPath = path.resolve(pathname);
      if (generation && !generationMatchesPath(resolvedPath, generation)) {
        return false;
      }
      failures.set(resolvedPath, { error, ...(generation ? { generation } : {}) });
      // Latch first. Close hooks may reenter.
      options.closeByPath(resolvedPath);
      if (generation && !generationMatchesPath(resolvedPath, generation)) {
        failures.delete(resolvedPath);
        return false;
      }
      return true;
    },
    clear: (pathname: string): void => {
      failures.delete(path.resolve(pathname));
    },
    clearAll: (rootPath?: string): void => {
      for (const pathname of failures.keys()) {
        if (rootPath === undefined || isPathInside(rootPath, pathname)) {
          failures.delete(pathname);
        }
      }
    },
  };
}
