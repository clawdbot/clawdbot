import {
  SQLITE_READONLY_CHILD_ARG,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

function formatWorkerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Copy strategies never attach SQLite to the source or change its WAL index.
// Async copies also keep private-directory PowerShell work off the sync path.
async function runWorker(): Promise<void> {
  const mode = process.argv[3];
  const pathname = process.argv[4];
  if ((mode !== "sync" && mode !== "async" && mode !== "async-copy") || !pathname) {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({
        ok: false,
        message: "SQLite read-only worker requires a mode and a database path",
      }),
    );
    return;
  }
  try {
    const prepared =
      mode === "sync"
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname)
        : await prepareSqliteReadOnlyLocationInProcess(
            pathname,
            mode === "async-copy" ? "copy" : "backup",
          );
    process.stdout.write(JSON.stringify({ ok: true, location: prepared.location }));
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ ok: false, message: formatWorkerError(error) }));
  }
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  void runWorker();
}
