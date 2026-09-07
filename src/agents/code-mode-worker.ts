import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  WorkerTaskError,
  WorkerTaskPool,
  type WorkerTaskRequestContext,
  type WorkerTaskResponse,
} from "../infra/worker-task-pool.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import {
  codeModeFailureCode,
  type CodeModeFailureCode,
  type CodeModeWorkerResult,
} from "./code-mode-runtime.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerContinuation,
} from "./code-mode-worker-types.js";

export type CodeModeWorkerInlineHost = {
  /** Append boundary output once. Continue with the remaining shared call budget;
   * checkpoint only when genuinely parking the VM (including an internal wait). Host tools keep
   * their cell-owner signal, not the shorter-lived worker-task signal. */
  onBoundary: (
    boundary: CodeModeWorkerBoundary,
    context: WorkerTaskRequestContext & {
      /** Exact queue/initialization-adjusted grant sent to the worker and enforced there. */
      maxTimeoutMs: number;
    },
  ) => Promise<CodeModeWorkerContinuation & { onConsumed?: () => void }>;
  onInputConsumed?: () => void;
};

const getQuickJsModules = createLazyPromise(async () => {
  const resolve = createRequire(import.meta.url).resolve;
  const compile = async (path: string) => WebAssembly.compile(await readFile(resolve(path)));
  const [wasmModule, encoding] = await Promise.all([
    compile("quickjs-wasi/quickjs.wasm"),
    compile("quickjs-wasi/encoding.so"),
  ]);
  return {
    wasmModule,
    wasmExtensions: [{ name: "encoding", wasm: encoding }],
  };
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
  inlineHost?: CodeModeWorkerInlineHost,
): Promise<CodeModeWorkerResult> {
  const pool = workerUrl
    ? new WorkerTaskPool<unknown, unknown>({ workerUrl, maxWorkers: 1 })
    : getCodeModePool(codeModeWorkerUrl());
  const startedAt = performance.now();
  let admittedTimeoutMs: number | undefined;
  try {
    const message = await pool.run(
      async () => {
        const modules = await getQuickJsModules();
        if (!isRecord(workerData)) {
          return workerData;
        }
        const config = isRecord(workerData.config) ? workerData.config : undefined;
        const prepared: Record<string, unknown> = { ...workerData, ...modules };
        if (config && typeof config.timeoutMs === "number") {
          // Queueing and initialization consume the same budget as parsing and execution.
          const admittedConfig = {
            ...config,
            timeoutMs: Math.max(0, config.timeoutMs - (performance.now() - startedAt)),
          };
          // Both sides receive the exact value produced by this single admission calculation.
          admittedTimeoutMs = admittedConfig.timeoutMs;
          prepared.config = admittedConfig;
        }
        return prepared;
      },
      {
        timeoutMs,
        signal,
        onInputConsumed: inlineHost?.onInputConsumed,
        onRequest: inlineHost
          ? async (value, context): Promise<WorkerTaskResponse> => {
              if (!isRecord(value) || value.status !== "boundary") {
                throw new Error("invalid code mode worker boundary");
              }
              if (
                admittedTimeoutMs === undefined ||
                !Number.isFinite(admittedTimeoutMs) ||
                admittedTimeoutMs <= 0
              ) {
                throw new Error("invalid code mode worker admission budget");
              }
              const { onConsumed, ...input } = await inlineHost.onBoundary(
                // SAFETY: The private worker owns this boundary, never a guest routing identity.
                value as CodeModeWorkerBoundary,
                { ...context, maxTimeoutMs: admittedTimeoutMs },
              );
              return {
                input,
                onConsumed,
                timeoutMs:
                  (input.kind === "continue" ? input.timeoutMs : 0) +
                  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
              };
            }
          : undefined,
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
      : failedCodeModeWorkerResult(
          error,
          error instanceof WorkerTaskError ? "runtime_unavailable" : codeModeFailureCode(error),
        );
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
