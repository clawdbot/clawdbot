// Sbx plugin module implements low-level process spawn behavior.
import { spawn } from "node:child_process";

type SpawnSbxOptions = {
  input?: Buffer | string;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowFailure?: boolean;
};

type SpawnSbxResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Spawn the `sbx` (or configured) binary, capturing stdout/stderr as buffers. */
export function spawnSbx(argv: string[], opts: SpawnSbxOptions = {}): Promise<SpawnSbxResult> {
  const [command, ...args] = argv;
  return new Promise<SpawnSbxResult>((resolve, reject) => {
    if (!command) {
      reject(new Error("sbx command is required"));
      return;
    }
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (opts.signal) {
        opts.signal.removeEventListener("abort", handleAbort);
      }
    };

    function handleAbort() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.kill("SIGTERM");
      reject(createAbortError());
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        handleAbort();
        return;
      }
      opts.signal.addEventListener("abort", handleAbort, { once: true });
    }

    if (opts.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(new Error(`sbx ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        reject(
          Object.assign(
            new Error(
              `Sandbox backend "sbx" requires the sbx CLI, but "${command}" was not found in PATH. Install Docker Desktop's Sandboxes feature or the standalone sbx CLI (https://github.com/docker/sbx-releases), or set agents.defaults.sandbox.backend to a different backend.`,
            ),
            { code: "INVALID_CONFIG", cause: error },
          ),
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts.allowFailure) {
        reject(
          Object.assign(
            new Error(stderr.toString("utf8").trim() || `sbx ${args.join(" ")} failed`),
            { code: exitCode, stdout, stderr },
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    const stdin = child.stdin;
    if (stdin) {
      if (opts.input !== undefined) {
        stdin.end(opts.input);
      } else {
        stdin.end();
      }
    }
  });
}
