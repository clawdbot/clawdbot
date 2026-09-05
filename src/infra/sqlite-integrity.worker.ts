import { parentPort, workerData } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  readSqliteIntegrityFileIdentity,
  type SqliteIntegrityWorkerInput,
  type SqliteIntegrityWorkerResult,
} from "./sqlite-integrity-worker.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";

function nativeErrorDetails(error: Error) {
  // SAFETY: Node's filesystem and SQLite errors attach these optional diagnostic fields.
  const nativeError = error as Error & { code?: string; errcode?: number };
  return { message: error.message, code: nativeError.code, errcode: nativeError.errcode };
}

// SAFETY: The private Worker is constructed only by assertSqliteIntegrityInWorker.
const input = workerData as SqliteIntegrityWorkerInput;
let database: import("node:sqlite").DatabaseSync | undefined;
let failure: Error | undefined;
try {
  readSqliteIntegrityFileIdentity(input.pathname, input.identity);
  database = openNodeSqliteDatabase(input.pathname, { readOnly: true });
  setSqliteBusyTimeout(database, input.busyTimeoutMs);
  readSqliteIntegrityFileIdentity(input.pathname, input.identity);
  assertSqliteIntegrity(database, input.pathname);
} catch (error) {
  failure = toStringifiedError(error);
} finally {
  try {
    database?.close();
  } catch (error) {
    failure = toStringifiedError(error);
  }
}
let result: SqliteIntegrityWorkerResult = { ok: true };
if (failure) {
  result = {
    ok: false,
    error: {
      name: failure.name,
      ...nativeErrorDetails(failure),
      ...(failure.cause instanceof Error ? { cause: nativeErrorDetails(failure.cause) } : {}),
    },
  };
}
// Node Worker ports take a transfer list, not a browser target origin.
parentPort?.postMessage(result, []);
