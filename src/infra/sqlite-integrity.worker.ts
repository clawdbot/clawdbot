import { once } from "node:events";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  readSqliteIntegrityFileIdentity,
  type SqliteIntegrityWorkerInput,
  type SqliteIntegrityWorkerMessage,
  type SqliteIntegrityWorkerPhase,
  type SqliteIntegrityWorkerResult,
} from "./sqlite-integrity-worker.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";

function nativeErrorDetails(error: Error) {
  // SAFETY: Node's filesystem and SQLite errors attach these optional diagnostic fields.
  const nativeError = error as Error & { code?: string; errcode?: number };
  return { message: error.message, code: nativeError.code, errcode: nativeError.errcode };
}

if (!process.send || !process.disconnect) {
  throw new Error("SQLite integrity child requires parent IPC.");
}
const sendMessage = process.send.bind(process);
const disconnect = process.disconnect.bind(process);

function sendPhase(phase: SqliteIntegrityWorkerPhase): Promise<void> {
  return new Promise((resolve, reject) => {
    // Flush each phase before native work can block this child's event loop.
    sendMessage({ type: "phase", phase } satisfies SqliteIntegrityWorkerMessage, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// SAFETY: Only assertSqliteIntegrityInWorker sends this private IPC input.
const [input] = (await once(process, "message")) as [SqliteIntegrityWorkerInput];
let database: import("node:sqlite").DatabaseSync | undefined;
let failure: Error | undefined;
try {
  await sendPhase("opening");
  readSqliteIntegrityFileIdentity(input.pathname, input.identity);
  database = openNodeSqliteDatabase(input.pathname, { readOnly: true });
  setSqliteBusyTimeout(database, input.busyTimeoutMs);
  readSqliteIntegrityFileIdentity(input.pathname, input.identity);
  await sendPhase("checking");
  assertSqliteIntegrity(database, input.pathname);
} catch (error) {
  failure = toStringifiedError(error);
} finally {
  if (database) {
    try {
      await sendPhase("closing");
    } catch (error) {
      // Reporting failure cannot replace a native failure or skip native close.
      failure ??= toStringifiedError(error);
    }
  }
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
sendMessage(result, disconnect);
