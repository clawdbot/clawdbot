import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";
import {
  SQLITE_READONLY_CHILD_ARG,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

// The sync strategy raw-copies without attaching SQLite to the source, so sync
// callers stay byte-neutral on the live family; the async strategy holds a read
// transaction on the source and may update its WAL index.
async function runWorker(): Promise<void> {
  const mode = process.argv[3];
  const pathname = process.argv[4];
  if ((mode !== "sync" && mode !== "async") || !pathname) {
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
        : await prepareSqliteReadOnlyLocationInProcess(pathname);
    process.stdout.write(JSON.stringify({ ok: true, location: prepared.location }));
  } catch (error) {
    process.exitCode = 1;
    const message = `${coerceErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}`;
    process.stdout.write(JSON.stringify({ ok: false, message }));
  }
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  void runWorker();
}
