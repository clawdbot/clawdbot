import { execFileSync, spawnSync } from "node:child_process";

export function readDiagnosticCommand(command, args, record) {
  const started = performance.now();
  record("census-command-start", { command, args });
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const complete = !result.error && result.status === 0;
  record("census-command-returned", {
    command,
    elapsedMs: performance.now() - started,
    pid: result.pid,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
    code: result.error?.code,
    error: result.error && String(result.error),
    complete,
    descendantStop: "not independently observed",
  });
  if (result.error) throw new Error(String(result.error));
  if (result.status !== 0) throw new Error(`Census command refused with status ${result.status}`);
  return result.stdout.trim();
}

export function readCommand(command, args, record) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    record("command-read-failed", {
      command,
      args,
      complete: false,
      stdout: error.stdout,
      stderr: error.stderr,
      status: error.status,
      signal: error.signal,
      code: error.code,
      error: String(error),
    });
    throw error;
  }
}
