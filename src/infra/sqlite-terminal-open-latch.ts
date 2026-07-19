import path from "node:path";

/**
 * Per-path latch for terminal database-open failures (newer schema, proven
 * corruption). Recording quarantines the path: any live handle is closed and
 * every later open fails fast until doctor repairs the file and clears it.
 */
export function createSqliteTerminalOpenLatch(options: {
  closeByPath: (pathname: string) => void;
}) {
  const failures = new Map<string, Error>();

  return {
    get: (pathname: string): Error | undefined => failures.get(path.resolve(pathname)),
    record: (pathname: string, error: Error): void => {
      const resolvedPath = path.resolve(pathname);
      failures.set(resolvedPath, error);
      // Latch first. Close hooks may reenter.
      options.closeByPath(resolvedPath);
    },
    clear: (pathname: string): void => {
      failures.delete(path.resolve(pathname));
    },
    clearAll: (): void => {
      failures.clear();
    },
  };
}
