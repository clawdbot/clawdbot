import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

export const SQLITE_READONLY_CHILD_ARG = "--openclaw-sqlite-readonly-child";
const SQLITE_READONLY_STDERR_TAIL_CHARS = 4_000;

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
      { encoding: "utf8", signal: options.signal },
      (error, stdout, stderr) => {
        output = {
          failure: error ? `exited unsuccessfully: ${error.message}` : undefined,
          stderr,
          stdout,
        };
      },
    );
    // execFile can report an abort/error before close. Ownership ends only
    // after the process and its pipes have closed, including failed launches.
    child.once("close", () => {
      try {
        options.signal?.throwIfAborted();
        resolve(readSqliteReadOnlyWorkerLocation(output));
      } catch (workerError) {
        reject(workerError instanceof Error ? workerError : new Error(String(workerError)));
      }
    });
  });
}

export function runSqliteReadOnlyWorkerSync(pathname: string): string {
  const result = spawnSync(process.execPath, sqliteReadOnlyWorkerArgv(pathname, "sync"), {
    encoding: "utf8",
  });
  const failure = result.error
    ? `failed to start: ${result.error.message}`
    : result.status === 0
      ? undefined
      : `exited with ${result.signal ? `signal ${result.signal}` : `code ${result.status}`}`;
  return readSqliteReadOnlyWorkerLocation({
    failure,
    stderr: result.stderr,
    stdout: result.stdout,
  });
}
