import { execFileSync } from "node:child_process";

const ANDROID_SIGNING_TIMEOUT_MS = 120_000;

export function runAndroidSigningCommandSync(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? ANDROID_SIGNING_TIMEOUT_MS;
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: options.encoding,
      env: options.env,
      killSignal: "SIGKILL",
      stdio: options.stdio,
      timeout: timeoutMs,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ETIMEDOUT") {
      throw new Error(
        `Android release signing command timed out after ${timeoutMs}ms: ${command}`,
        { cause: error },
      );
    }
    throw error;
  }
}
