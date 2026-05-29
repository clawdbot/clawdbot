import { execFileSync } from "node:child_process";

export type NpmVerifyCommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const DEFAULT_NPM_VERIFY_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function runNpmVerifyCommand(
  invocation: NpmVerifyCommandInvocation,
  cwd: string,
  options: { maxBufferBytes?: number; timeoutMs?: number } = {},
): string {
  const timeoutMs =
    options.timeoutMs ??
    positiveEnvInt("OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS", DEFAULT_NPM_VERIFY_COMMAND_TIMEOUT_MS);
  const maxBuffer =
    options.maxBufferBytes ??
    positiveEnvInt(
      "OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES",
      DEFAULT_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES,
    );

  return execFileSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }).trim();
}
