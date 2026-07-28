import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  errorMessage,
  type CodeModeFailureCode,
  type CodeModeWorkerResult,
} from "./code-mode-runtime.js";

let quickJsWasmModulePromise: Promise<WebAssembly.Module> | undefined;

function getQuickJsWasmModule(): Promise<WebAssembly.Module> {
  quickJsWasmModulePromise ??= Promise.resolve()
    .then(() => createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"))
    .then((wasmPath) => readFile(wasmPath))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      // Failed initialization is transient host state, not a process-wide
      // verdict; later runs must retry without bypassing their watchdog.
      quickJsWasmModulePromise = undefined;
      throw error;
    });
  return quickJsWasmModulePromise;
}

export function resolveCodeModeWorkerUrl(currentModuleUrl: string): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const distMarker = `${path.sep}dist${path.sep}`;
  const distIndex = currentPath.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length - 1);
    return pathToFileURL(path.join(distRoot, "agents", "code-mode.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./code-mode.worker${extension}`, currentModuleUrl);
}

function codeModeWorkerUrl(): URL {
  return resolveCodeModeWorkerUrl(import.meta.url);
}

function failedCodeModeWorkerResult(
  error: unknown,
  code: CodeModeFailureCode,
): Extract<CodeModeWorkerResult, { status: "failed" }> {
  return {
    status: "failed",
    error: errorMessage(error),
    code,
    output: [],
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

export function normalizeCodeModeWorkerResult(result: CodeModeWorkerResult): CodeModeWorkerResult {
  return normalizeCodeModeTimeoutResult(result);
}

export async function runCodeModeWorker(
  workerData: unknown,
  timeoutMs: number,
  workerUrl?: URL,
  signal?: AbortSignal,
): Promise<CodeModeWorkerResult> {
  const resolvedWorkerUrl = workerUrl ?? codeModeWorkerUrl();
  const sourceWorkerExecArgv = resolvedWorkerUrl.pathname.endsWith(".ts")
    ? ["--import", "tsx"]
    : undefined;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<CodeModeWorkerResult>((resolve) => {
      let settled = false;
      const finish = (result: CodeModeWorkerResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      timer = setTimeout(() => {
        finish({
          status: "failed",
          error: "code mode worker timeout exceeded",
          code: "timeout",
          output: [],
        });
      }, timeoutMs);
      onAbort = () => {
        const abortReason = signal?.reason;
        finish({
          status: "failed",
          error:
            abortReason instanceof CodeModeHeadlessTimeoutError
              ? "code mode timeout exceeded"
              : "code mode execution aborted",
          code: abortReason instanceof CodeModeHeadlessTimeoutError ? "timeout" : "aborted",
          output: [],
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      // Compilation is part of the same execution deadline. A timed-out or
      // aborted initialization must never create a worker after settlement.
      void getQuickJsWasmModule().then(
        (wasmModule) => {
          if (settled) {
            return;
          }
          try {
            worker = new Worker(resolvedWorkerUrl, {
              workerData: isRecord(workerData) ? { ...workerData, wasmModule } : workerData,
              execArgv: sourceWorkerExecArgv,
            });
          } catch (error) {
            finish(failedCodeModeWorkerResult(error, "runtime_unavailable"));
            return;
          }

          worker.once("message", (message: unknown) => {
            const result = isRecord(message)
              ? (message as CodeModeWorkerResult)
              : ({
                  status: "failed",
                  error: "invalid code mode worker response",
                  code: "internal_error",
                  output: [],
                } satisfies CodeModeWorkerResult);
            finish(normalizeCodeModeWorkerResult(result));
          });
          worker.once("error", (error) => {
            finish(failedCodeModeWorkerResult(error, "runtime_unavailable"));
          });
          worker.once("exit", (code) => {
            // A clean exit without a response is still unavailable; `finish`
            // prevents normal message-then-exit from replacing a real result.
            finish(
              failedCodeModeWorkerResult(
                new Error(`code mode worker exited with code ${code} before returning a result`),
                "runtime_unavailable",
              ),
            );
          });
        },
        (error: unknown) => {
          finish(failedCodeModeWorkerResult(error, "runtime_unavailable"));
        },
      );
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
    await worker?.terminate();
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
