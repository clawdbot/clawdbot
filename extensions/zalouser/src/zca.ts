import { spawn, type SpawnOptions } from "node:child_process";

import type { ZcaResult, ZcaRunOptions } from "./types.js";

const ZCA_BINARY = "zca";
const DEFAULT_TIMEOUT = 30000;

function buildArgs(args: string[], options?: ZcaRunOptions): string[] {
  const result: string[] = [];
  // Profile flag comes first (before subcommand)
  const profile = options?.profile || process.env.ZCA_PROFILE;
  if (profile) {
    result.push("--profile", profile);
  }
  result.push(...args);
  return result;
}

export async function runZca(
  args: string[],
  options?: ZcaRunOptions,
): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    };

    const proc = spawn(ZCA_BINARY, fullArgs, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr: stderr || "Command timed out",
          exitCode: code ?? 124,
        });
        return;
      }
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

export function runZcaInteractive(
  args: string[],
  options?: ZcaRunOptions,
): Promise<ZcaResult> {
  const fullArgs = buildArgs(args, options);

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      cwd: options?.cwd,
      env: { ...process.env },
      stdio: "inherit",
    };

    const proc = spawn(ZCA_BINARY, fullArgs, spawnOpts);

    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: "",
        stderr: "",
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

export function parseJsonOutput<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export async function checkZcaInstalled(): Promise<boolean> {
  const result = await runZca(["--version"], { timeout: 5000 });
  return result.ok;
}

export type ZcaStreamingOptions = ZcaRunOptions & {
  onData?: (data: string) => void;
  onError?: (err: Error) => void;
};

export function runZcaStreaming(
  args: string[],
  options?: ZcaStreamingOptions,
): { proc: ReturnType<typeof spawn>; promise: Promise<ZcaResult> } {
  const fullArgs = buildArgs(args, options);

  const spawnOpts: SpawnOptions = {
    cwd: options?.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  };

  const proc = spawn(ZCA_BINARY, fullArgs, spawnOpts);
  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    stdout += text;
    options?.onData?.(text);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  const promise = new Promise<ZcaResult>((resolve) => {
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      options?.onError?.(err);
      resolve({
        ok: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });

  return { proc, promise };
}
