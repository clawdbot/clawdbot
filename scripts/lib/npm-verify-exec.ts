// Npm Verify Exec script supports OpenClaw repository automation.
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readPositiveEnvInt } from "./numeric-options.mjs";

export type NpmVerifyCommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

type NpmVerifyExecOptions = ExecFileSyncOptionsWithStringEncoding & {
  windowsVerbatimArguments?: boolean;
};

const DEFAULT_NPM_VERIFY_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function runNpmVerifyCommand(
  invocation: NpmVerifyCommandInvocation,
  cwd: string,
  options: { maxBufferBytes?: number; timeoutMs?: number } = {},
): string {
  const timeoutMs =
    options.timeoutMs ??
    readPositiveEnvInt(
      "OPENCLAW_NPM_VERIFY_COMMAND_TIMEOUT_MS",
      process.env,
      DEFAULT_NPM_VERIFY_COMMAND_TIMEOUT_MS,
    );
  const maxBuffer =
    options.maxBufferBytes ??
    readPositiveEnvInt(
      "OPENCLAW_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES",
      process.env,
      DEFAULT_NPM_VERIFY_COMMAND_MAX_BUFFER_BYTES,
    );

  const execOptions: NpmVerifyExecOptions = {
    cwd,
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
  return execFileSync(invocation.command, invocation.args, execOptions).trim();
}
