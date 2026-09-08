import { fork } from "node:child_process";
import fs from "node:fs";
import { formatByteSize } from "@openclaw/normalization-core";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sameFileIdentity, type FileIdentityStat } from "./fs-safe-advanced.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import {
  SQLITE_INSPECTION_TIMEOUT_MS,
  resolveSqliteIntegrityTimeoutMs,
} from "./sqlite-readonly-worker.js";

const log = createSubsystemLogger("state/sqlite");

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

export type SqliteIntegrityWorkerPhase = "opening" | "checking" | "closing";

export type SqliteIntegrityWorkerMessage =
  | SqliteIntegrityWorkerResult
  | { type: "phase"; phase: SqliteIntegrityWorkerPhase };

export function readSqliteIntegrityFileIdentity(
  pathname: string,
  expected?: FileIdentityStat,
): FileIdentityStat & { size: bigint } {
  const current = fs.statSync(pathname, { bigint: true });
  if (!current.isFile() || (expected && !sameFileIdentity(expected, current))) {
    throw new Error(`SQLite source changed during integrity admission: ${pathname}`);
  }
  return { dev: current.dev, ino: current.ino, size: current.size };
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
  const timeoutMs = resolveSqliteIntegrityTimeoutMs(identity.size);
  const size = formatByteSize(Number(identity.size), {
    style: "iec",
    maxUnit: "giga",
    separator: " ",
    fractionDigits: identity.size < 1024n ? 0 : 1,
  });
  const entry = resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
  if (timeoutMs > SQLITE_INSPECTION_TIMEOUT_MS) {
    log.info(`SQLite integrity check for ${pathname}: ${size}, budget ${timeoutMs / 1000} seconds`);
  }
  const worker = fork(entry, [], {
    execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    signal,
  });
  return new Promise((resolve, reject) => {
    let result: SqliteIntegrityWorkerResult | undefined;
    let failure: Error | undefined;
    let lastObservedPhase: SqliteIntegrityWorkerPhase | "starting" | "result-received" = "starting";
    worker.on("message", (message: SqliteIntegrityWorkerMessage) => {
      if ("type" in message && message.type === "phase") {
        if (
          !result &&
          (message.phase === "opening" ||
            message.phase === "checking" ||
            message.phase === "closing")
        ) {
          lastObservedPhase = message.phase;
        }
      } else if ("ok" in message) {
        result = message;
        lastObservedPhase = "result-received";
      }
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
          const error = new Error(
            `SQLite integrity check timed out after ${timeoutMs / 1000} seconds (budget for ${size}) for ${pathname}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance.`,
          );
          error.message += ` (lastObservedPhase=${lastObservedPhase})`;
          throw error;
        }
        if (code !== 0 || !result) {
          throw new Error(
            `SQLite integrity worker exited ${code} without a completed check (lastObservedPhase=${lastObservedPhase})`,
          );
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
