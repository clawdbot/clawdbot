import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import type { CodeModeFailureCode, CodeModeWorkerResult } from "./code-mode-runtime.js";

const getQuickJsWasmModule = createLazyPromise(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
  return WebAssembly.compile(await readFile(wasmPath));
});

function codeModeWorkerUrl(): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "code-mode.worker",
    distWorkerPath: "agents/code-mode.worker.js",
  });
}

function failedCodeModeWorkerResult(
  error: unknown,
  code: CodeModeFailureCode,
): Extract<CodeModeWorkerResult, { status: "failed" }> {
  return {
    status: "failed",
    error: formatErrorMessage(error),
    code,
    failurePhase: "host",
    bridgeDispatchStarted: false,
    output: EMPTY_CODE_MODE_OUTPUT,
  };
}

export function normalizeCodeModeTimeoutResult<
  T extends { status: string; code?: unknown; error?: unknown },
>(result: T): T {
  if (
    result.status === "failed" &&
    result.code === "timeout" &&
    !String(result.error).includes("timeout exceeded")
  ) {
    return {
      ...result,
      error: "code mode timeout exceeded",
    } as T;
  }
  return result;
}

let sharedPool: { url: string; pool: WorkerTaskPool<unknown, unknown> } | undefined;

function getCodeModePool(url: URL): WorkerTaskPool<unknown, unknown> {
  if (sharedPool?.url !== url.href) {
    // A runtime entry change retires its old workers; ordinary runs reuse the
    // process-stable entry while each request still creates an isolated VM.
    void sharedPool?.pool.close();
    sharedPool = { url: url.href, pool: new WorkerTaskPool({ workerUrl: url }) };
  }
  return sharedPool.pool;
}

export async function runCodeModeWorker(
  workerData: unknown,
  timeoutMs: number,
  workerUrl?: URL,
  signal?: AbortSignal,
): Promise<CodeModeWorkerResult> {
  const pool = workerUrl
    ? new WorkerTaskPool<unknown, unknown>({ workerUrl, maxWorkers: 1 })
    : getCodeModePool(codeModeWorkerUrl());
  const startedAt = performance.now();
  try {
    const message = await pool.run(
      async () => {
        const wasmModule = await getQuickJsWasmModule();
        if (!isRecord(workerData)) {
          return workerData;
        }
        const config = isRecord(workerData.config) ? workerData.config : undefined;
        return {
          ...workerData,
          wasmModule,
          // Queueing and initialization consume the same guest budget as
          // parsing and execution; admission must not restart the deadline.
          ...(config && typeof config.timeoutMs === "number"
            ? {
                config: {
                  ...config,
                  timeoutMs: Math.max(0, config.timeoutMs - (performance.now() - startedAt)),
                },
              }
            : {}),
        };
      },
      {
        timeoutMs,
        signal,
        // A committed resume consumes this snapshot. Failure already closes
        // the run, so transferring ownership avoids copying its entire heap.
        transferList: (input) =>
          isRecord(input) && isRecord(input.snapshot) && input.snapshot.memory instanceof Uint8Array
            ? [input.snapshot.memory.buffer as ArrayBuffer] // SAFETY: QuickJS.snapshot owns a dedicated ArrayBuffer.
            : [],
      },
    );
    return isRecord(message)
      ? normalizeCodeModeTimeoutResult(message as CodeModeWorkerResult)
      : failedCodeModeWorkerResult("invalid code mode worker response", "internal_error");
  } catch (error) {
    if (signal?.aborted) {
      return failedCodeModeWorkerResult(
        signal.reason instanceof CodeModeHeadlessTimeoutError
          ? "code mode timeout exceeded"
          : "code mode execution aborted",
        signal.reason instanceof CodeModeHeadlessTimeoutError ? "timeout" : "aborted",
      );
    }
    return error instanceof WorkerTaskError && error.code === "timeout"
      ? failedCodeModeWorkerResult("code mode worker timeout exceeded", "timeout")
      : failedCodeModeWorkerResult(error, "runtime_unavailable");
  } finally {
    if (workerUrl) {
      await pool.close();
    }
  }
}

export class CodeModeHeadlessAbortError extends Error {
  constructor(message = "code mode execution aborted") {
    super(message);
    this.name = "CodeModeHeadlessAbortError";
  }
}

export class CodeModeHeadlessTimeoutError extends Error {
  constructor(message = "code mode headless wall-clock timeout exceeded") {
    super(message);
    this.name = "CodeModeHeadlessTimeoutError";
  }
}
