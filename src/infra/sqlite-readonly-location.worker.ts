import {
  SQLITE_READONLY_CHILD_ARG,
  prepareSqliteReadOnlyLocationInProcess,
} from "./sqlite-readonly-location.js";

function formatWorkerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWorker(): Promise<void> {
  const pathname = process.argv[3];
  if (!pathname) {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({ ok: false, message: "SQLite read-only worker requires a database path" }),
    );
    return;
  }
  try {
    const prepared = await prepareSqliteReadOnlyLocationInProcess(pathname);
    process.stdout.write(JSON.stringify({ ok: true, location: prepared.location }));
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ ok: false, message: formatWorkerError(error) }));
  }
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  void runWorker();
}
