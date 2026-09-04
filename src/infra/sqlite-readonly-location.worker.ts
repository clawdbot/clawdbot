import { coerceErrorMessage, extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SQLITE_READONLY_CHILD_ARG,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

function formatWorkerError(error: unknown): string {
  const message = coerceErrorMessage(error);
  const details = new Set<string>();
  // Only allowlisted codes cross this boundary, through at most eight cause nodes.
  // Full error formatting would expose cause prose or arbitrary structured data.
  for (let depth = 0, current = error; depth < 8 && isRecord(current); depth += 1) {
    const code = extractErrorCode(current);
    if (code && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      details.add(`code=${code}`);
    }
    const errcode = current.errcode;
    if (
      typeof errcode === "number" &&
      Number.isInteger(errcode) &&
      errcode >= 0 &&
      errcode <= 0x7fff_ffff
    ) {
      details.add(`errcode=${errcode}`);
    }
    current = current.cause;
  }
  return details.size > 0 ? `${message} (${[...details].join(", ")})` : message;
}

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
    process.stdout.write(JSON.stringify({ ok: false, message: formatWorkerError(error) }));
  }
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  void runWorker();
}
