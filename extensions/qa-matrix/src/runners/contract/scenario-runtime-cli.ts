import { spawn as startOpenClawCliProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export type MatrixQaCliRunResult = {
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type MatrixQaCliSession = {
  args: string[];
  endStdin: () => void;
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

function isMatrixQaCliSecretPositionalArg(args: string[], index: number): boolean {
  return args[0] === "matrix" && args[1] === "verify" && args[2] === "device" && index === 3;
}

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
    if (isMatrixQaCliSecretPositionalArg(args, index)) {
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
  allowNonZero?: boolean;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
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
  if (params.stdin !== undefined) {
    child.stdin.end(params.stdin);
  }
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
    if (result.exitCode !== 0 && params.allowNonZero !== true) {
      finish(result, new Error(formatMatrixQaCliExitError(result)));
      return;
    }
    finish(result);
  });

  return {
    args: params.args,
    endStdin: () => {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    },
    output: readOutput,
    wait: async () =>
      await new Promise<MatrixQaCliRunResult>((resolve, reject) => {
        if (closed && closeResult) {
          if (closeResult.exitCode === 0 || params.allowNonZero === true) {
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
  allowNonZero?: boolean;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
}): Promise<MatrixQaCliRunResult> {
  return await startMatrixQaOpenClawCli(params).wait();
}

async function assertMatrixQaPrivatePathMode(pathToCheck: string, label: string) {
  if (process.platform === "win32") {
    return;
  }
  const mode = (await stat(pathToCheck)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad: ${mode.toString(8)}`);
  }
}

export async function createMatrixQaOpenClawCliRuntime(params: {
  accountId: string;
  accessToken: string;
  artifactLabel: string;
  baseUrl: string;
  deviceId: string;
  displayName: string;
  outputDir: string;
  runtimeEnv: NodeJS.ProcessEnv;
  userId: string;
}) {
  const rootDir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-cli-qa-"),
  );
  const artifactDir = path.join(
    params.outputDir,
    params.artifactLabel.replace(/[^A-Za-z0-9_-]/g, "-"),
    randomUUID().replaceAll("-", "").slice(0, 12),
  );
  const stateDir = path.join(rootDir, "state");
  const configPath = path.join(rootDir, "config.json");
  await chmod(rootDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(rootDir, "Matrix QA CLI temp directory");
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  await chmod(artifactDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(artifactDir, "Matrix QA CLI artifact directory");
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  await chmod(stateDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(stateDir, "Matrix QA CLI state directory");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        plugins: {
          allow: ["matrix"],
          entries: {
            matrix: { enabled: true },
          },
        },
        channels: {
          matrix: {
            defaultAccount: params.accountId,
            accounts: {
              [params.accountId]: {
                accessToken: params.accessToken,
                deviceId: params.deviceId,
                encryption: true,
                homeserver: params.baseUrl,
                initialSyncLimit: 0,
                name: params.displayName,
                network: {
                  dangerouslyAllowPrivateNetwork: true,
                },
                startupVerification: "off",
                userId: params.userId,
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await assertMatrixQaPrivatePathMode(configPath, "Matrix QA CLI config file");
  const env = {
    ...params.runtimeEnv,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_AUTO_UPDATE: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  return {
    artifactDir,
    configPath,
    dispose: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    run: async (
      args: string[],
      opts: { allowNonZero?: boolean; stdin?: string; timeoutMs: number },
    ): Promise<MatrixQaCliRunResult> =>
      await runMatrixQaOpenClawCli({
        allowNonZero: opts.allowNonZero,
        args,
        env,
        stdin: opts.stdin,
        timeoutMs: opts.timeoutMs,
      }),
    start: (args: string[], opts: { allowNonZero?: boolean; timeoutMs: number }) =>
      startMatrixQaOpenClawCli({
        allowNonZero: opts.allowNonZero,
        args,
        env,
        timeoutMs: opts.timeoutMs,
      }),
    stateDir,
  };
}
