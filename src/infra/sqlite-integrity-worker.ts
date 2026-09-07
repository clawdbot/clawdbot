import { fork } from "node:child_process";
import fs from "node:fs";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import {
  SQLITE_INSPECTION_TIMEOUT_MS,
  sqliteInspectionTimeoutError,
} from "./sqlite-readonly-worker.js";

export type SqliteIntegrityWorkerInput = {
  pathname: string;
  identity: FileIdentityStat;
  busyTimeoutMs: number;
};

export type SqliteIntegrityWorkerResult =
  | { ok: true }
  | {
      ok: false;
      error: {
        name: string;
        message: string;
        code?: string;
        errcode?: number;
        cause?: { message: string; code?: string; errcode?: number };
      };
    };

export function readSqliteIntegrityFileIdentity(
  pathname: string,
  expected?: FileIdentityStat,
): FileIdentityStat {
  const current = fs.statSync(pathname, { bigint: true });
  if (!current.isFile() || (expected && !sameFileIdentity(expected, current))) {
    throw new Error(`SQLite source changed during integrity admission: ${pathname}`);
  }
  return { dev: current.dev, ino: current.ino };
}

/** The caller retains its owning lease until the read-only child closes. */
export function assertSqliteIntegrityInWorker(
  pathname: string,
  busyTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  // The caller retains its owning lease through native exit. This witness
  // detects observed path swaps; it is not native descriptor authority.
  const identity = readSqliteIntegrityFileIdentity(pathname);
  const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
  const worker = fork(entry, [], {
    execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    timeout: SQLITE_INSPECTION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    signal,
  });
  return new Promise((resolve, reject) => {
    let result: SqliteIntegrityWorkerResult | undefined;
    let failure: Error | undefined;
    worker.on("message", (message: SqliteIntegrityWorkerResult) => {
      result = message;
    });
    worker.on("error", (error) => {
      failure = toStringifiedError(error);
    });
    // Native cancellation/timeout kills the child; ownership ends only at close.
    worker.once("close", (code, closeSignal) => {
      try {
        signal.throwIfAborted();
        if (failure) {
          throw failure;
        }
        if (worker.killed && closeSignal === "SIGKILL") {
          throw sqliteInspectionTimeoutError("integrity check", pathname);
        }
        if (code !== 0 || !result) {
          throw new Error(`SQLite integrity worker exited ${code} without a completed check`);
        }
        readSqliteIntegrityFileIdentity(pathname, identity);
        if (!result.ok) {
          const cause = result.error.cause
            ? Object.assign(new Error(result.error.cause.message), result.error.cause)
            : undefined;
          throw Object.assign(new Error(result.error.message, cause ? { cause } : undefined), {
            name: result.error.name,
            code: result.error.code,
            errcode: result.error.errcode,
          });
        }
        resolve();
      } catch (error) {
        reject(toStringifiedError(error));
      }
    });
    if (!signal.aborted) {
      worker.send(
        { pathname, identity, busyTimeoutMs } satisfies SqliteIntegrityWorkerInput,
        (error) => {
          if (error) {
            failure = error;
            worker.kill("SIGKILL");
          }
        },
      );
    }
  });
}
