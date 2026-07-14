import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { killProcessTree } from "../../process/kill-tree.js";
import { workerSshCommandOptions } from "./ssh.js";

const STDERR_LIMIT = 4_096;
const COMMAND_KILL_GRACE_MS = 300;
const COMMAND_CLOSE_GRACE_MS = 1_000;

function validateGitRelativePath(file: string): string {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file === ".." ||
    file.startsWith("../")
  ) {
    throw new Error("Worker workspace git file list contains an unsafe path");
  }
  return file;
}

async function* readNulFile(filePath: string): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const value of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const separator = buffer.indexOf(0, offset);
      if (separator < 0) {
        break;
      }
      yield validateGitRelativePath(buffer.subarray(offset, separator).toString("utf8"));
      offset = separator + 1;
    }
    pending = Buffer.from(buffer.subarray(offset));
  }
  if (pending.length > 0) {
    throw new Error("Worker workspace git file list is not NUL terminated");
  }
}

export async function runLocalCommandToFile(params: {
  argv: string[];
  inputPath?: string;
  outputPath: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  const [command, ...args] = params.argv;
  if (!command) {
    throw new Error("Worker workspace command requires an executable");
  }
  const output = await fs.open(params.outputPath, "wx", 0o600);
  const input = params.inputPath ? await fs.open(params.inputPath, "r") : undefined;
  let stderr = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    if (params.signal.aborted) {
      throw new Error("Worker workspace file enumeration was aborted");
    }
    const child = spawn(command, args, {
      env: workerSshCommandOptions({ timeoutMs: params.timeoutMs }).baseEnv,
      stdio: [input?.fd ?? "ignore", output.fd, "pipe"],
      ...(process.platform !== "win32" ? { detached: true } : {}),
      windowsHide: true,
    });
    const childStderr = child.stderr;
    if (!childStderr) {
      throw new Error("Worker workspace command has no stderr pipe");
    }
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr = sliceUtf16Safe(`${stderr}${chunk}`, -STDERR_LIMIT);
    });
    const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error?: Error }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      let terminationStarted = false;
      const terminate = () => {
        if (settled || terminationStarted) {
          return;
        }
        terminationStarted = true;
        const pid = child.pid;
        if (typeof pid === "number" && pid > 0) {
          killProcessTree(pid, { graceMs: COMMAND_KILL_GRACE_MS });
        } else {
          child.kill("SIGTERM");
        }
        // A descendant can retain stderr even after the direct child exits. Bound
        // shutdown so placement replacement cannot wait forever on that pipe.
        terminationTimer = setTimeout(() => {
          if (typeof pid === "number" && pid > 0) {
            killProcessTree(pid, { force: true });
          } else {
            child.kill("SIGKILL");
          }
          childStderr.destroy();
          finish({ code: null });
        }, COMMAND_KILL_GRACE_MS + COMMAND_CLOSE_GRACE_MS);
        terminationTimer.unref?.();
      };
      child.once("error", (error) => finish({ code: null, error }));
      child.once("close", (code) => finish({ code }));
      abort = terminate;
      params.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(terminate, params.timeoutMs);
      timer.unref?.();
      if (params.signal.aborted) {
        terminate();
      }
    });
    if (result.error) {
      throw result.error;
    }
    if (params.signal.aborted) {
      throw new Error("Worker workspace file enumeration was aborted");
    }
    if (result.code !== 0) {
      throw new Error(
        stderr.trim()
          ? `Worker workspace file enumeration failed: ${stderr.trim()}`
          : "Worker workspace file enumeration failed",
      );
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(terminationTimer);
    if (abort) {
      params.signal.removeEventListener("abort", abort);
    }
    await output.close();
    await input?.close();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

export async function writeEligibleGitFiles(params: {
  gitRoot: string;
  eligiblePath: string;
  ignoredPath: string;
  selectedPath: string;
  outputPath: string;
}): Promise<void> {
  const output = await fs.open(params.outputPath, "wx", 0o600);
  const canonicalRoot = await fs.realpath(params.gitRoot);
  let buffered: string[] = [];
  let bufferedBytes = 0;
  const flush = async () => {
    if (buffered.length === 0) {
      return;
    }
    await output.write(buffered.join(""));
    buffered = [];
    bufferedBytes = 0;
  };
  const appendIfTransferable = async (file: string) => {
    const absolute = path.join(canonicalRoot, file);
    const stats = await fs.lstat(absolute).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    // Gitlinks are directories. Keep their commit in the base repository without
    // recursively copying nested repositories or their credential-bearing metadata.
    if (!stats || (!stats.isFile() && !stats.isSymbolicLink())) {
      return;
    }
    if (stats.isSymbolicLink()) {
      // Mirrors the remote manifest guard, but before transfer: macOS openrsync
      // stat-fails escaping links with an opaque error instead of copying them.
      const target = await fs.readlink(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (
        resolvedTarget !== canonicalRoot &&
        !resolvedTarget.startsWith(canonicalRoot + path.sep)
      ) {
        throw new Error(`worker workspace symlink escapes the sync root: ${file}`);
      }
    }
    const record = `${file}\0`;
    buffered.push(record);
    bufferedBytes += Buffer.byteLength(record);
    if (bufferedBytes >= 64 * 1024) {
      await flush();
    }
  };
  try {
    for await (const file of readNulFile(params.eligiblePath)) {
      await appendIfTransferable(file);
    }
    const ignored = readNulFile(params.ignoredPath)[Symbol.asyncIterator]();
    const selected = readNulFile(params.selectedPath)[Symbol.asyncIterator]();
    let ignoredItem = await ignored.next();
    let selectedItem = await selected.next();
    while (!ignoredItem.done && !selectedItem.done) {
      const order = Buffer.compare(Buffer.from(ignoredItem.value), Buffer.from(selectedItem.value));
      if (order === 0) {
        await appendIfTransferable(ignoredItem.value);
        ignoredItem = await ignored.next();
        selectedItem = await selected.next();
      } else if (order < 0) {
        ignoredItem = await ignored.next();
      } else {
        selectedItem = await selected.next();
      }
    }
    await flush();
  } finally {
    await output.close();
  }
}
