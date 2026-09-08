import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";
const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;
// A 300 MiB synthetic database took 1.13–3.15 s to snapshot and <1 s to
// integrity-check. Leave storage headroom after admission has excluded writers.
export const SQLITE_INSPECTION_TIMEOUT_MS = 30_000;

export function sqliteInspectionTimeoutError(operation: string, pathname: string): Error {
  return new Error(
    `SQLite ${operation} timed out after 30 seconds for ${pathname}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance.`,
  );
}

type SqliteReadOnlyWorkerResult = { ok: true; location: string } | { ok: false; message: string };
type SqliteReadOnlyWorkerOutput = { failure?: string; stderr: string; stdout: string };

function isSqliteReadOnlyWorkerResult(value: unknown): value is SqliteReadOnlyWorkerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2 || !("ok" in value)) {
    return false;
  }
  return (
    (value.ok === true && "location" in value && typeof value.location === "string") ||
    (value.ok === false && "message" in value && typeof value.message === "string")
  );
}

function createSqliteReadOnlyWorkerError(message: string, stderr: string): Error {
  const stderrTail = stderr.trim().slice(-SQLITE_READONLY_STDERR_TAIL_CHARS);
  return new Error(
    `SQLite read-only worker ${message}${stderrTail ? `\nstderr (tail): ${stderrTail}` : ""}`,
  );
}

function parseSqliteReadOnlyWorkerResult(
  stdout: string,
  stderr: string,
): SqliteReadOnlyWorkerResult {
  if (!stdout.trim()) {
    throw createSqliteReadOnlyWorkerError("returned no JSON result", stderr);
  }
  let message: unknown;
  try {
    message = JSON.parse(stdout);
  } catch {
    throw createSqliteReadOnlyWorkerError("returned invalid JSON", stderr);
  }
  if (!isSqliteReadOnlyWorkerResult(message)) {
    throw createSqliteReadOnlyWorkerError("returned an invalid result", stderr);
  }
  return message;
}

function readSqliteReadOnlyWorkerLocation(params: SqliteReadOnlyWorkerOutput): string {
  let result: SqliteReadOnlyWorkerResult;
  try {
    result = parseSqliteReadOnlyWorkerResult(params.stdout, params.stderr);
  } catch (error) {
    if (params.failure) {
      throw createSqliteReadOnlyWorkerError(params.failure, params.stderr);
    }
    throw error;
  }
  if (params.failure || !result.ok) {
    throw createSqliteReadOnlyWorkerError(
      !result.ok ? result.message : (params.failure ?? "failed"),
      params.stderr,
    );
  }
  return result.location;
}

function sqliteReadOnlyWorkerArgv(pathname: string, mode: "sync" | "async", stagingRoot?: string) {
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
  return [
    ...resolveRuntimeWorkerArgv(workerUrl),
    SQLITE_READONLY_CHILD_ARG,
    mode,
    path.resolve(pathname),
    ...(stagingRoot ? [stagingRoot] : []),
  ];
}

export function runSqliteReadOnlyWorker(
  pathname: string,
  options: { mode: "sync" | "async"; stagingRoot?: string; signal?: AbortSignal },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output: SqliteReadOnlyWorkerOutput = { stderr: "", stdout: "" };
    const child = execFile(
      process.execPath,
      sqliteReadOnlyWorkerArgv(pathname, options.mode, options.stagingRoot),
      {
        encoding: "utf8",
        timeout: SQLITE_INSPECTION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        output = {
          failure: error
            ? error.killed && error.signal === "SIGKILL" && error.code == null
              ? sqliteInspectionTimeoutError("read-only snapshot", pathname).message
              : `exited unsuccessfully: ${error.message}`
            : undefined,
          stderr,
          stdout,
        };
      },
    );
    // execFile does not forward killSignal for AbortSignal cancellation.
    const abort = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }
    // execFile can report an abort/error before close. Ownership ends only
    // after the process and its pipes have closed, including failed launches.
    child.once("close", () => {
      options.signal?.removeEventListener("abort", abort);
      try {
        options.signal?.throwIfAborted();
        resolve(readSqliteReadOnlyWorkerLocation(output));
      } catch (workerError) {
        reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
      }
    });
  });
}

export function runSqliteReadOnlyWorkerSync(pathname: string, stagingRoot: string): string {
  const result = spawnSync(
    process.execPath,
    sqliteReadOnlyWorkerArgv(pathname, "sync", stagingRoot),
    {
      encoding: "utf8",
      timeout: SQLITE_INSPECTION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const failure = result.error
    ? hasErrnoCode(result.error, "ETIMEDOUT")
      ? sqliteInspectionTimeoutError("read-only snapshot", pathname).message
      : `failed to start: ${result.error.message}`
    : result.status === 0
      ? undefined
      : `exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`;
  return readSqliteReadOnlyWorkerLocation({
    failure,
    stderr: result.stderr,
    stdout: result.stdout,
  });
}
