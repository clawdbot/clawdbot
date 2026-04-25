import { spawn as startOpenClawCliProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";

export type MatrixQaCliRunResult = {
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type MatrixQaCliSession = {
  args: string[];
  output: () => { stderr: string; stdout: string };
  wait: () => Promise<MatrixQaCliRunResult>;
  waitForOutput: (
    predicate: (output: { stderr: string; stdout: string; text: string }) => boolean,
    label: string,
    timeoutMs: number,
  ) => Promise<{ stderr: string; stdout: string; text: string }>;
  writeStdin: (text: string) => Promise<void>;
  kill: () => void;
};

const MATRIX_QA_CLI_SECRET_ARG_FLAGS = new Set(["--access-token", "--password", "--recovery-key"]);

function redactMatrixQaCliArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const [flag] = arg.split("=", 1);
    if (MATRIX_QA_CLI_SECRET_ARG_FLAGS.has(flag) && arg.includes("=")) {
      return `${flag}=[REDACTED]`;
    }
    const previous = args[index - 1];
    if (previous && MATRIX_QA_CLI_SECRET_ARG_FLAGS.has(previous)) {
      return "[REDACTED]";
    }
    return arg;
  });
}

export function redactMatrixQaCliOutput(text: string): string {
  return redactSensitiveText(text);
}

export function formatMatrixQaCliCommand(args: string[]) {
  return `openclaw ${redactMatrixQaCliArgs(args).join(" ")}`;
}

export function resolveMatrixQaOpenClawCliEntryPath(cwd: string): string {
  const mjsEntryPath = path.join(cwd, "dist", "index.mjs");
  if (existsSync(mjsEntryPath)) {
    return mjsEntryPath;
  }
  return path.join(cwd, "dist", "index.js");
}

function buildMatrixQaCliResult(params: {
  args: string[];
  exitCode: number;
  output: { stderr: string; stdout: string };
}): MatrixQaCliRunResult {
  return {
    args: params.args,
    exitCode: params.exitCode,
    stderr: params.output.stderr,
    stdout: params.output.stdout,
  };
}

function formatMatrixQaCliExitError(result: MatrixQaCliRunResult) {
  return [
    `${formatMatrixQaCliCommand(result.args)} exited ${result.exitCode}`,
    result.stderr.trim() ? `stderr:\n${redactMatrixQaCliOutput(result.stderr.trim())}` : null,
    result.stdout.trim() ? `stdout:\n${redactMatrixQaCliOutput(result.stdout.trim())}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function startMatrixQaOpenClawCli(params: {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): MatrixQaCliSession {
  const cwd = params.cwd ?? process.cwd();
  const distEntryPath = resolveMatrixQaOpenClawCliEntryPath(cwd);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let closed = false;
  let closeResult: MatrixQaCliRunResult | undefined;
  let settleWait:
    | {
        reject: (error: Error) => void;
        resolve: (result: MatrixQaCliRunResult) => void;
      }
    | undefined;

  const child = startOpenClawCliProcess(process.execPath, [distEntryPath, ...params.args], {
    cwd,
    env: params.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readOutput = () => ({
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  });
  const finish = (result: MatrixQaCliRunResult, error?: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    closeResult = result;
    if (!settleWait) {
      return;
    }
    if (error) {
      settleWait.reject(error);
    } else {
      settleWait.resolve(result);
    }
  };

  const timeout = setTimeout(() => {
    const result = buildMatrixQaCliResult({
      args: params.args,
      exitCode: 1,
      output: readOutput(),
    });
    child.kill("SIGTERM");
    finish(
      result,
      new Error(`${formatMatrixQaCliCommand(params.args)} timed out after ${params.timeoutMs}ms`),
    );
  }, params.timeoutMs);

  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    clearTimeout(timeout);
    finish(
      buildMatrixQaCliResult({
        args: params.args,
        exitCode: 1,
        output: readOutput(),
      }),
      error,
    );
  });
  child.on("close", (exitCode) => {
    clearTimeout(timeout);
    const result = buildMatrixQaCliResult({
      args: params.args,
      exitCode: exitCode ?? 1,
      output: readOutput(),
    });
    if (result.exitCode !== 0) {
      finish(result, new Error(formatMatrixQaCliExitError(result)));
      return;
    }
    finish(result);
  });

  return {
    args: params.args,
    output: readOutput,
    wait: async () =>
      await new Promise<MatrixQaCliRunResult>((resolve, reject) => {
        if (closed && closeResult) {
          if (closeResult.exitCode === 0) {
            resolve(closeResult);
          } else {
            reject(new Error(formatMatrixQaCliExitError(closeResult)));
          }
          return;
        }
        settleWait = { reject, resolve };
      }).catch((error) => {
        throw new Error(
          `Matrix QA CLI command failed (${formatMatrixQaCliCommand(params.args)}): ${redactMatrixQaCliOutput(formatErrorMessage(error))}`,
        );
      }),
    waitForOutput: async (predicate, label, timeoutMs) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const output = readOutput();
        const text = `${output.stdout}\n${output.stderr}`;
        if (predicate({ ...output, text })) {
          return { ...output, text };
        }
        if (closed) {
          break;
        }
        await sleep(Math.min(100, Math.max(25, timeoutMs - (Date.now() - startedAt))));
      }
      const output = readOutput();
      throw new Error(
        `${formatMatrixQaCliCommand(params.args)} did not print ${label} before timeout\nstdout:\n${redactMatrixQaCliOutput(output.stdout.trim())}\nstderr:\n${redactMatrixQaCliOutput(output.stderr.trim())}`,
      );
    },
    writeStdin: async (text) => {
      if (!child.stdin.write(text)) {
        await new Promise<void>((resolve) => child.stdin.once("drain", resolve));
      }
    },
    kill: () => {
      if (!closed) {
        child.kill("SIGTERM");
      }
    },
  };
}

export async function runMatrixQaOpenClawCli(params: {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<MatrixQaCliRunResult> {
  return await startMatrixQaOpenClawCli(params).wait();
}
