import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-worker-url.js";

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

/** The caller retains its canonical runtime lease until the read-only Worker exits. */
export function assertSqliteIntegrityInWorker(
  pathname: string,
  busyTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  // The caller retains its runtime lease through native exit. This witness
  // detects observed path swaps; it is not native descriptor authority.
  const identity = readSqliteIntegrityFileIdentity(pathname);
  const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
  const worker = new Worker(entry, {
    workerData: { pathname, identity, busyTimeoutMs } satisfies SqliteIntegrityWorkerInput,
    execArgv: entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined,
  });
  return new Promise((resolve, reject) => {
    let result: SqliteIntegrityWorkerResult | undefined;
    let failure: Error | undefined;
    const abort = () => {
      // A termination request cannot interrupt SQLite's native call. Exit owns
      // completion, so the caller cannot release its lease while a scan remains.
      void worker.terminate().catch((error: unknown) => {
        failure = toStringifiedError(error);
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: SqliteIntegrityWorkerResult) => {
      result = message;
    });
    worker.on("error", (error) => {
      failure = toStringifiedError(error);
    });
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      try {
        signal.throwIfAborted();
        if (failure) {
          throw failure;
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
    if (signal.aborted) {
      abort();
    }
  });
}
