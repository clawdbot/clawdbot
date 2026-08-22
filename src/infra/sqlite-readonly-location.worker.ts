import {
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

const SQLITE_READONLY_ASYNC_CHILD_ARG = "--openclaw-sqlite-readonly-async-child";
const SQLITE_READONLY_SYNC_CHILD_ARG = "--openclaw-sqlite-readonly-sync-child";

function formatWorkerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[2] === SQLITE_READONLY_SYNC_CHILD_ARG) {
  const pathname = process.argv[3];
  if (!pathname) {
    process.stderr.write("SQLite read-only worker requires a database path\n");
    process.exitCode = 1;
  } else {
    try {
      const prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname);
      process.stdout.write(JSON.stringify({ location: prepared.location }));
    } catch (error) {
      process.stderr.write(`${formatWorkerError(error)}\n`);
      process.exitCode = 1;
    }
  }
}

const sendToParent =
  process.argv[2] === SQLITE_READONLY_ASYNC_CHILD_ARG ? process.send?.bind(process) : undefined;
if (sendToParent) {
  process.once("message", (message: unknown) => {
    void (async () => {
      let cleanup: (() => boolean) | undefined;
      const result = await (async () => {
        if (typeof message !== "string") {
          return { error: "SQLite read-only worker requires a database path" };
        }
        try {
          const prepared = await prepareSqliteReadOnlyLocationInProcess(message);
          cleanup = prepared.cleanup;
          return { location: prepared.location };
        } catch (error) {
          return { error: formatWorkerError(error) };
        }
      })();
      await new Promise<void>((resolve, reject) => {
        sendToParent(result, (error) => {
          if (error) {
            reject(error);
          } else {
            cleanup = undefined;
            resolve();
          }
        });
      }).catch(() => {
        cleanup?.();
        process.exitCode = 1;
      });
      process.disconnect?.();
    })();
  });
}
