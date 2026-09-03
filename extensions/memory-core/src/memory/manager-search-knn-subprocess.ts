// Parent-side subprocess boundary for synchronous sqlite-vec KNN work.
import { spawn } from "node:child_process";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { vectorKnnProcessEntrypoint } from "./manager-search-knn-entrypoint.js";
import type { VectorKnnChildInput, VectorKnnChildResult } from "./manager-search-knn.child.js";
import {
  isVectorKnnRow,
  type VectorKnnRequest,
  type VectorKnnResponse,
} from "./manager-search-knn.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_EXIT_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_VECTOR_KNN_CHILDREN = 2;

class VectorKnnSubprocessError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "failed" | "protocol" | "termination-timeout",
  ) {
    super(message);
    this.name = "VectorKnnSubprocessError";
  }
}

function buildChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (env[name]) {
      childEnv[name] = env[name];
    }
  }
  return childEnv;
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("memory vector KNN aborted");
}

function createVectorKnnAdmission(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<{
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }> = [];

  const releaseNext = (): void => {
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      next.signal?.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) {
        next.reject(toAbortError(next.signal));
        continue;
      }
      next.resolve(createRelease());
      return;
    }
    active -= 1;
  };
  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseNext();
    };
  };

  return {
    acquire: async (signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw toAbortError(signal);
      }
      if (active < maxConcurrent) {
        active += 1;
        return createRelease();
      }
      return await new Promise<() => void>((resolve, reject) => {
        const waiter = {
          signal,
          resolve,
          reject,
          abort: () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(toAbortError(signal!));
          },
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        if (signal?.aborted) {
          waiter.abort();
        }
      });
    },
  };
}

const vectorKnnAdmission = createVectorKnnAdmission(MAX_CONCURRENT_VECTOR_KNN_CHILDREN);

function parseChildResult(output: Buffer, maxRows: number): VectorKnnResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned malformed JSON",
      "protocol",
    );
  }
  if (!parsed || typeof parsed !== "object" || !("status" in parsed)) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid envelope",
      "protocol",
    );
  }
  // SAFETY: the envelope object/status guard above narrows the only protocol discriminator.
  const result = parsed as VectorKnnChildResult;
  if (result.status === "failed") {
    throw new VectorKnnSubprocessError(result.error || "memory vector KNN child failed", "failed");
  }
  if (
    result.status !== "ok" ||
    !result.value ||
    !Array.isArray(result.value.rows) ||
    result.value.rows.length > maxRows ||
    result.value.rows.some((row) => !isVectorKnnRow(row)) ||
    typeof result.value.fallbackScanRequired !== "boolean"
  ) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid result",
      "protocol",
    );
  }
  return result.value;
}

type VectorKnnSubprocessParams = {
  databasePath: string;
  extensionPath?: string;
  request: VectorKnnRequest;
  signal?: AbortSignal;
};

/** Run one file-backed KNN query in a bounded, OS-killable child process. */
export async function runVectorKnnInSubprocess(
  params: VectorKnnSubprocessParams,
): Promise<VectorKnnResponse> {
  if (params.signal?.aborted) {
    throw toAbortError(params.signal);
  }
  const input: VectorKnnChildInput = {
    databasePath: params.databasePath,
    extensionPath: params.extensionPath,
    request: params.request,
  };
  const inputPayload = Buffer.from(JSON.stringify(input), "utf8");
  if (inputPayload.byteLength > MAX_STDIN_BYTES) {
    throw new VectorKnnSubprocessError("memory vector KNN child input is too large", "protocol");
  }

  const releaseAdmission = await vectorKnnAdmission.acquire(params.signal);
  if (params.signal?.aborted) {
    releaseAdmission();
    throw toAbortError(params.signal);
  }
  let child;
  try {
    const childUrl = resolveRuntimeWorkerUrl(vectorKnnProcessEntrypoint);
    child = spawn(process.execPath, resolveRuntimeWorkerArgv(childUrl), {
      env: buildChildEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    releaseAdmission();
    throw new VectorKnnSubprocessError(
      error instanceof Error ? error.message : String(error),
      "unavailable",
    );
  }
  return await new Promise<VectorKnnResponse>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let closed = false;
    let callerSettled = false;
    let terminationReason: Error | undefined;
    let killExitTimer: ReturnType<typeof setTimeout> | undefined;

    const clearKillExitTimer = () => {
      if (killExitTimer) {
        clearTimeout(killExitTimer);
        killExitTimer = undefined;
      }
    };
    const settleCaller = (action: () => void) => {
      if (callerSettled) {
        return;
      }
      callerSettled = true;
      params.signal?.removeEventListener("abort", abort);
      action();
    };
    const releaseClosedChild = () => {
      clearKillExitTimer();
      params.signal?.removeEventListener("abort", abort);
      releaseAdmission();
    };
    const requestTermination = (reason: Error) => {
      if (terminationReason || closed) {
        return;
      }
      terminationReason = reason;
      child.stdin.destroy();
      // This read-only Node child creates no descendants. Kill the owned handle:
      // native SQLite cannot service graceful shutdown while its query is busy.
      child.kill("SIGKILL");
      killExitTimer = setTimeout(() => {
        if (!closed) {
          // The caller may return, but this child keeps its admission slot until
          // close. Destroying pipes and unref'ing prevents one unkillable OS task
          // from pinning the Gateway while the slot bounds future accumulation.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settleCaller(() =>
            reject(
              new VectorKnnSubprocessError(
                "memory vector KNN child did not exit after SIGKILL",
                "termination-timeout",
              ),
            ),
          );
        }
      }, KILL_EXIT_TIMEOUT_MS);
    };
    const abort = () => {
      requestTermination(toAbortError(params.signal!));
    };

    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) {
      abort();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        const failure = new VectorKnnSubprocessError(
          "memory vector KNN child stdout exceeded its limit",
          "protocol",
        );
        stdoutChunks.length = 0;
        requestTermination(failure);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        const failure = new VectorKnnSubprocessError(
          "memory vector KNN child stderr exceeded its limit",
          "protocol",
        );
        requestTermination(failure);
        return;
      }
      stderrChunks.push(chunk);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (!terminationReason && error.code !== "EPIPE") {
        requestTermination(new VectorKnnSubprocessError(error.message, "failed"));
      }
    });
    child.once("error", (error) => {
      requestTermination(new VectorKnnSubprocessError(error.message, "unavailable"));
    });
    child.once("close", (code, signal) => {
      closed = true;
      // close is the authoritative process/stdio completion; a recycled numeric
      // PID must not turn a successful query into a false cleanup failure.
      releaseClosedChild();
      settleCaller(() => {
        if (terminationReason) {
          reject(terminationReason);
          return;
        }
        if (code !== 0 || signal) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          reject(
            new VectorKnnSubprocessError(
              `memory vector KNN child exited before returning a result (code ${code}, signal ${signal ?? "none"})${stderr ? `: ${stderr}` : ""}`,
              "failed",
            ),
          );
          return;
        }
        try {
          resolve(parseChildResult(Buffer.concat(stdoutChunks), params.request.limit));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new VectorKnnSubprocessError(String(error), "protocol"),
          );
        }
      });
    });
    child.stdin.end(inputPayload);
  });
}
