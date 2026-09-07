import { execFileSync } from "node:child_process";

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
