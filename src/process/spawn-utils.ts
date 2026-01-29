import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SpawnFallback = {
  label: string;
  options: SpawnOptions;
};

export type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
  fallbackLabel?: string;
};

type SpawnWithFallbackParams = {
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnFallback[];
  spawnImpl?: typeof spawn;
  retryCodes?: string[];
  onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};

const DEFAULT_RETRY_CODES = ["EBADF"];

export function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"] {
  const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
  return [stdin, "pipe", "pipe"];
}

export function formatSpawnError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const details = err as NodeJS.ErrnoException;
  const parts: string[] = [];
  const message = err.message?.trim();
  if (message) parts.push(message);
  if (details.code && !message?.includes(details.code)) parts.push(details.code);
  if (details.syscall) parts.push(`syscall=${details.syscall}`);
  if (typeof details.errno === "number") parts.push(`errno=${details.errno}`);
  return parts.join(" ");
}

function shouldRetry(err: unknown, codes: string[]): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code.length > 0 && codes.includes(code);
}

// Fake child process interface for EBADF workaround
interface FakeChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  killed: boolean;
  kill: () => boolean;
}

// EBADF workaround: capture output via temp files, use stdio: ignore for spawn
function createFakeChildFromSync(argv: string[], options: SpawnOptions): ChildProcess {
  const fakeChild: FakeChildProcess = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: process.pid,
    killed: false,
    kill: () => {
      fakeChild.killed = true;
      return true;
    },
  });

  const child = fakeChild as unknown as ChildProcess;

  // Extract command from argv (typically [shell, "-c", command])
  const command = argv.length >= 3 ? argv[2] : argv.join(" ");

  // Create temp files for output capture
  const tmpDir = os.tmpdir();
  const id = `clawdbot-ebadf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stdoutFile = path.join(tmpDir, `${id}.stdout`);
  const stderrFile = path.join(tmpDir, `${id}.stderr`);

  // Wrap command to redirect output to files
  const wrappedCommand = `( ${command} ) > "${stdoutFile}" 2> "${stderrFile}"`;

  setImmediate(() => {
    try {
      // spawnSync with stdio: ignore - no pipes needed
      const result = spawnSync("/bin/sh", ["-c", wrappedCommand], {
        cwd: options.cwd || process.cwd(),
        timeout: 300000,
        stdio: "ignore",
      });

      if (result.error) {
        // Clean up temp files
        try {
          fs.unlinkSync(stdoutFile);
        } catch {}
        try {
          fs.unlinkSync(stderrFile);
        } catch {}
        fakeChild.emit("error", result.error);
        return;
      }

      fakeChild.pid = result.pid || process.pid;

      // Read output from temp files
      try {
        const stdoutData = fs.readFileSync(stdoutFile, "utf8");
        if (stdoutData) fakeChild.stdout.write(stdoutData);
      } catch {}

      try {
        const stderrData = fs.readFileSync(stderrFile, "utf8");
        if (stderrData) fakeChild.stderr.write(stderrData);
      } catch {}

      // Clean up temp files
      try {
        fs.unlinkSync(stdoutFile);
      } catch {}
      try {
        fs.unlinkSync(stderrFile);
      } catch {}

      fakeChild.stdout.end();
      fakeChild.stderr.end();
      fakeChild.emit("close", result.status, result.signal);
    } catch (err) {
      // Clean up temp files
      try {
        fs.unlinkSync(stdoutFile);
      } catch {}
      try {
        fs.unlinkSync(stderrFile);
      } catch {}
      fakeChild.emit("error", err);
    }
  });

  // Emit spawn immediately
  process.nextTick(() => {
    fakeChild.emit("spawn");
  });

  return child;
}

async function spawnAndWaitForSpawn(
  spawnImpl: typeof spawn,
  argv: string[],
  options: SpawnOptions,
  useSyncFallback = false,
): Promise<ChildProcess> {
  let child: ChildProcess;

  if (useSyncFallback) {
    child = createFakeChildFromSync(argv, options);
  } else {
    child = spawnImpl(argv[0], argv.slice(1), options);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(child);
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onSpawn = () => {
      finishResolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    // Ensure mocked spawns that never emit "spawn" don't stall.
    process.nextTick(() => {
      if (typeof child.pid === "number") {
        finishResolve();
      }
    });
  });
}

export async function spawnWithFallback(
  params: SpawnWithFallbackParams,
): Promise<SpawnWithFallbackResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];
  const attempts: Array<{ label?: string; options: SpawnOptions; useSync?: boolean }> = [
    { options: baseOptions, useSync: false },
    ...fallbacks.map((fallback) => ({
      label: fallback.label,
      options: { ...baseOptions, ...fallback.options },
      useSync: false,
    })),
    // Final EBADF fallback: spawnSync with stdio:ignore + file capture
    { label: "file-capture", options: baseOptions, useSync: true },
  ];

  let lastError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const child = await spawnAndWaitForSpawn(
        spawnImpl,
        params.argv,
        attempt.options,
        attempt.useSync,
      );
      return {
        child,
        usedFallback: index > 0,
        fallbackLabel: attempt.label,
      };
    } catch (err) {
      lastError = err;
      const nextAttempt = attempts[index + 1];
      if (!nextAttempt || !shouldRetry(err, retryCodes)) {
        throw err;
      }
      if (nextAttempt.label) {
        params.onFallback?.(err, {
          label: nextAttempt.label,
          options: nextAttempt.options,
        });
      }
    }
  }

  throw lastError;
}
