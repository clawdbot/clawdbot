// Agent Core module implements nodejs behavior.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileInfo,
  type FileKind,
  ok,
  type Result,
  toError,
} from "../types.js";
import { killProcessTree } from "./kill-tree.js";

const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Convert user-facing timeout seconds into a positive, timer-safe millisecond delay. */
function resolveExecTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return undefined;
  }
  const milliseconds = Math.floor(timeoutSeconds * 1000);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return 1;
  }
  return Math.min(milliseconds, MAX_TIMER_TIMEOUT_MS);
}

function fileKindFromStats(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileKind | undefined {
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return undefined;
}

function fileInfoFromStats(
  path: string,
  stats: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  },
): Result<FileInfo, FileError> {
  const kind = fileKindFromStats(stats);
  if (!kind) {
    return err(new FileError("invalid", "Unsupported file type", path));
  }
  return ok({
    name: basename(path),
    path,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) {
    return error;
  }
  const cause = toError(error);
  if (isNodeError(error)) {
    const message = error.message;
    switch (error.code) {
      case "ABORT_ERR":
        return new FileError("aborted", message, path, cause);
      case "ENOENT":
        return new FileError("not_found", message, path, cause);
      case "EACCES":
      case "EPERM":
        return new FileError("permission_denied", message, path, cause);
      case "ENOTDIR":
        return new FileError("not_directory", message, path, cause);
      case "EISDIR":
        return new FileError("is_directory", message, path, cause);
      case "EINVAL":
        return new FileError("invalid", message, path, cause);
      default:
        break;
    }
  }
  return new FileError("unknown", cause.message, path, cause);
}

function abortResult(
  signal: AbortSignal | undefined,
  path?: string,
): Result<never, FileError> | undefined {
  return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

type ChildOutputStreamName = "stdout" | "stderr";

function listenForChildOutputErrors(
  child: ReturnType<typeof spawn>,
  onError: (stream: ChildOutputStreamName, error: Error) => void,
): void {
  for (const streamName of ["stdout", "stderr"] as const) {
    child[streamName]?.on("error", (error: Error) => onError(streamName, error));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
  return await new Promise((resolveLocal) => {
    let stdout = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolveLocal({ stdout: "", status: null });
      return;
    }
    const timeout = setTimeout(() => {
      if (child.pid) {
        killProcessTree(child.pid, { force: true, detached: false });
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    listenForChildOutputErrors(child, () => {
      if (child.pid) {
        killProcessTree(child.pid, { force: true, detached: false });
      }
      clearTimeout(timeout);
      resolveLocal({ stdout: "", status: null });
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolveLocal({ stdout: "", status: null });
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolveLocal({ stdout, status });
    });
  });
}

async function findBashOnPath(): Promise<string | null> {
  const result =
    process.platform === "win32"
      ? await runCommand("where", ["bash.exe"], 5000)
      : await runCommand("which", ["bash"], 5000);
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
  return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

async function getShellConfig(
  customShellPath?: string,
): Promise<Result<{ shell: string; args: string[] }, ExecutionError>> {
  if (customShellPath) {
    if (await pathExists(customShellPath)) {
      return ok({ shell: customShellPath, args: ["-c"] });
    }
    return err(
      new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`),
    );
  }
  if (process.platform === "win32") {
    const candidates: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return ok({ shell: candidate, args: ["-c"] });
      }
    }
    const bashOnPath = await findBashOnPath();
    if (bashOnPath) {
      return ok({ shell: bashOnPath, args: ["-c"] });
    }
    return err(new ExecutionError("shell_unavailable", "No bash shell found"));
  }

  if (await pathExists("/bin/bash")) {
    return ok({ shell: "/bin/bash", args: ["-c"] });
  }
  const bashOnPath = await findBashOnPath();
  if (bashOnPath) {
    return ok({ shell: bashOnPath, args: ["-c"] });
  }
  return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
  baseEnv?: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...baseEnv,
    ...extraEnv,
  };
}

/** Node-backed execution environment for agent harness filesystem and shell operations. */
export class NodeExecutionEnv implements ExecutionEnv {
  cwd: string;
  private shellPath?: string;
  private shellEnv?: NodeJS.ProcessEnv;

  constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
    this.cwd = options.cwd;
    this.shellPath = options.shellPath;
    this.shellEnv = options.shellEnv;
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(resolvePath(this.cwd, path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(join(...parts));
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
      abortSignal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options?.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "aborted"));
    }

    const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
    const shellConfig = await getShellConfig(this.shellPath);
    if (!shellConfig.ok) {
      return shellConfig;
    }

    return await new Promise((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let callbackError: ExecutionError | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};

      const onAbort = () => {
        if (child?.pid) {
          killProcessTree(child.pid, { force: true });
        }
      };

      const settle = (
        result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>,
      ) => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        if (options?.abortSignal) {
          options.abortSignal.removeEventListener("abort", onAbort);
        }
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise(result);
      };

      try {
        child = spawn(shellConfig.value.shell, [...shellConfig.value.args, command], {
          cwd,
          detached: process.platform !== "win32",
          env: getShellEnv(this.shellEnv, options?.env),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        const cause = toError(error);
        settle(err(new ExecutionError("spawn_error", cause.message, cause)));
        return;
      }

      const timeoutMs = resolveExecTimeoutMs(options?.timeout);
      timeoutRef.current =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              if (child?.pid) {
                killProcessTree(child.pid, { force: true });
              }
            }, timeoutMs);

      if (options?.abortSignal) {
        if (options.abortSignal.aborted) {
          onAbort();
        } else {
          options.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        try {
          options?.onStdout?.(chunk);
        } catch (error) {
          const cause = toError(error);
          callbackError = new ExecutionError("callback_error", cause.message, cause);
          onAbort();
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        try {
          options?.onStderr?.(chunk);
        } catch (error) {
          const cause = toError(error);
          callbackError = new ExecutionError("callback_error", cause.message, cause);
          onAbort();
        }
      });

      // Guard stdout/stderr against stream errors (e.g. EPIPE when the
      // child exits before all pipe data is consumed). Without listeners,
      // Node.js throws an uncaught exception that crashes the process.
      const onStreamError = (stream: ChildOutputStreamName, error: Error) => {
        if (settled) {
          return;
        }
        onAbort();
        settle(
          err(new ExecutionError("spawn_error", `${stream} read error: ${error.message}`, error)),
        );
      };
      listenForChildOutputErrors(child, onStreamError);

      child.on("error", (error) => {
        settle(err(new ExecutionError("spawn_error", error.message, error)));
      });

      child.on("close", (code) => {
        if (callbackError) {
          settle(err(callbackError));
          return;
        }
        if (timedOut) {
          settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
          return;
        }
        if (options?.abortSignal?.aborted) {
          settle(err(new ExecutionError("aborted", "aborted")));
          return;
        }
        settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
      });
    });
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(options?.abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    if (options?.maxLines !== undefined && options.maxLines <= 0) {
      return ok([]);
    }
    let stream: ReturnType<typeof createReadStream> | undefined;
    let lineReader: ReturnType<typeof createInterface> | undefined;
    try {
      stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
      lineReader = createInterface({ input: stream, crlfDelay: Infinity });
      const lines: string[] = [];
      for await (const line of lineReader) {
        const loopAbort = abortResult(options?.abortSignal, resolved);
        if (loopAbort) {
          return loopAbort;
        }
        lines.push(line);
        if (options?.maxLines !== undefined && lines.length >= options.maxLines) {
          break;
        }
      }
      const afterReadAbort = abortResult(options?.abortSignal, resolved);
      if (afterReadAbort) {
        return afterReadAbort;
      }
      return ok(lines);
    } catch (error) {
      return err(toFileError(error, resolved));
    } finally {
      lineReader?.close();
      stream?.destroy();
    }
  }

  async readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      return ok(await readFile(resolved, { signal: abortSignal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      const afterMkdirAbort = abortResult(abortSignal, resolved);
      if (afterMkdirAbort) {
        return afterMkdirAbort;
      }
      await writeFile(resolved, content, { signal: abortSignal });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      await appendFile(resolved, content);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      return fileInfoFromStats(resolved, await lstat(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult(abortSignal, resolved);
    if (aborted) {
      return aborted;
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const infos: FileInfo[] = [];
      for (const entry of entries) {
        const loopAbort = abortResult(abortSignal, resolved);
        if (loopAbort) {
          return loopAbort;
        }
        const entryPath = resolve(resolved, entry.name);
        try {
          const info = fileInfoFromStats(entryPath, await lstat(entryPath));
          if (info.ok) {
            infos.push(info.value);
          }
        } catch (error) {
          return err(toFileError(error, entryPath));
        }
      }
      return ok(infos);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      return ok(await realpath(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path);
    if (result.ok) {
      return ok(true);
    }
    if (result.error.code === "not_found") {
      return ok(false);
    }
    return err(result.error);
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolved, { recursive: options?.recursive ?? true });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await rm(resolved, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async createTempDir(prefix = "tmp-"): Promise<Result<string, FileError>> {
    try {
      return ok(await mkdtemp(join(tmpdir(), prefix)));
    } catch (error) {
      return err(toFileError(error));
    }
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
  }): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-");
    if (!dir.ok) {
      return dir;
    }
    const filePath = join(
      dir.value,
      `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`,
    );
    try {
      await writeFile(filePath, "");
      return ok(filePath);
    } catch (error) {
      return err(toFileError(error, filePath));
    }
  }

  async cleanup(): Promise<void> {
    // nothing to clean up for the local node implementation
  }
}
