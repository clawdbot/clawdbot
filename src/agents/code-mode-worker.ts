import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CodeModeFailureCode,
  CodeModeSnapshotAttempt,
  CodeModeWorkerResult,
} from "./code-mode-runtime.js";
import {
  CODE_MODE_BRIDGE_METHODS,
  type CodeModeSnapshotMeasurement,
  type CodeModeWorkerThreadResult,
  type PendingBridgeRequest,
} from "./code-mode-worker-types.js";

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
    error: formatErrorMessage(error),
    code,
    failurePhase: "host",
    bridgeDispatchStarted: false,
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

type RunCodeModeWorkerOptions = {
  workerData: unknown;
  timeoutMs: number;
  workerUrl?: URL;
  signal?: AbortSignal;
  onWorkerSpawned?: () => void;
};

const WORKER_BRIDGE_METHODS = new Set<string>(CODE_MODE_BRIDGE_METHODS);

const WORKER_FAILURE_CODES = new Set<string>([
  "invalid_input",
  "runtime_unavailable",
  "timeout",
  "output_limit_exceeded",
  "snapshot_limit_exceeded",
  "internal_error",
] satisfies readonly Extract<CodeModeWorkerThreadResult, { status: "failed" }>["code"][]);

function isPendingBridgeRequest(value: unknown): value is PendingBridgeRequest {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.method !== "string" ||
    !WORKER_BRIDGE_METHODS.has(value.method) ||
    !value.id.startsWith(`bridge:${value.method}:`) ||
    !/^bridge:[A-Za-z]+:[1-9]\d*$/u.test(value.id) ||
    !Array.isArray(value.args) ||
    !isJsonSafe(value.args) ||
    typeof value.argumentBytes !== "number" ||
    !Number.isSafeInteger(value.argumentBytes)
  ) {
    return false;
  }
  return value.argumentBytes === Buffer.byteLength(JSON.stringify(value.args), "utf8");
}

function isJsonSafe(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length &&
      value.every((entry) => isJsonSafe(entry, ancestors))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((entry) => isJsonSafe(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function configuredSnapshotLimit(workerData: unknown): number | undefined {
  if (!isRecord(workerData) || !isRecord(workerData.config)) {
    return undefined;
  }
  const value = workerData.config.maxSnapshotBytes;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isWorkerThreadResult(
  value: unknown,
  measurement: CodeModeSnapshotMeasurement | undefined,
): value is CodeModeWorkerThreadResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.output) ||
    !value.output.every((entry) => isJsonSafe(entry))
  ) {
    return false;
  }
  if (value.status === "completed") {
    return isJsonSafe(value.value);
  }
  if (value.status === "waiting") {
    const settlementMode = value.settlementMode;
    if (
      measurement === undefined ||
      !(value.snapshotBytes instanceof Uint8Array) ||
      value.snapshotBytes.byteLength !== measurement.bytes ||
      !Array.isArray(value.pendingRequests) ||
      value.pendingRequests.length === 0 ||
      !isRecord(settlementMode)
    ) {
      return false;
    }
    const pendingIds = new Set<string>();
    for (const request of value.pendingRequests) {
      if (!isPendingBridgeRequest(request) || pendingIds.has(request.id)) {
        return false;
      }
      pendingIds.add(request.id);
    }
    if (settlementMode.kind === "awaiting") {
      return !("requiredRequestIds" in settlementMode);
    }
    if (
      settlementMode.kind !== "draining" ||
      !Array.isArray(settlementMode.requiredRequestIds) ||
      settlementMode.requiredRequestIds.length !== pendingIds.size
    ) {
      return false;
    }
    const requiredIds = new Set<string>();
    for (const requestId of settlementMode.requiredRequestIds) {
      if (
        typeof requestId !== "string" ||
        requiredIds.has(requestId) ||
        !pendingIds.has(requestId)
      ) {
        return false;
      }
      requiredIds.add(requestId);
    }
    return true;
  }
  return (
    value.status === "failed" &&
    typeof value.error === "string" &&
    typeof value.code === "string" &&
    WORKER_FAILURE_CODES.has(value.code) &&
    (value.failurePhase === "input" || value.failurePhase === "guest") &&
    value.bridgeDispatchStarted === false &&
    (value.bridgeRequestId === undefined ||
      (typeof value.bridgeRequestId === "string" &&
        /^bridge:[A-Za-z]+:[1-9]\d*$/u.test(value.bridgeRequestId)))
  );
}

function snapshotAttempt(
  disposition: CodeModeSnapshotAttempt["disposition"],
  measurement: CodeModeSnapshotMeasurement | undefined,
  rejectionReason?: CodeModeSnapshotAttempt["rejectionReason"],
): CodeModeSnapshotAttempt {
  return {
    disposition,
    ...(rejectionReason ? { rejectionReason } : {}),
    ...(measurement ? { measurement } : {}),
    coverage: measurement ? "exact" : "lower_bound",
  };
}

export async function runCodeModeWorker(
  options: RunCodeModeWorkerOptions,
): Promise<CodeModeWorkerResult> {
  const resolvedWorkerUrl = options.workerUrl ?? codeModeWorkerUrl();
  const maxSnapshotBytes = configuredSnapshotLimit(options.workerData);
  const sourceWorkerExecArgv = resolvedWorkerUrl.pathname.endsWith(".ts")
    ? ["--import", "tsx"]
    : undefined;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<CodeModeWorkerResult>((resolve) => {
      let settled = false;
      let snapshotStarted = false;
      let measurement: CodeModeSnapshotMeasurement | undefined;
      const finish = (result: CodeModeWorkerResult, attempt?: CodeModeSnapshotAttempt) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(attempt ? { ...result, snapshotAttempt: attempt } : result);
      };
      const invalidResponse = (
        snapshotObserved = snapshotStarted,
        observedMeasurement = measurement,
      ) =>
        finish(
          failedCodeModeWorkerResult(
            new Error("invalid code mode worker response"),
            "internal_error",
          ),
          snapshotObserved ? snapshotAttempt("rejected", observedMeasurement, "schema") : undefined,
        );
      const incompleteAttempt = () =>
        snapshotStarted ? snapshotAttempt("incomplete", measurement) : undefined;
      timer = setTimeout(() => {
        finish(
          {
            status: "failed",
            error: "code mode worker timeout exceeded",
            code: "timeout",
            failurePhase: "host",
            bridgeDispatchStarted: false,
            output: [],
          },
          incompleteAttempt(),
        );
      }, options.timeoutMs);
      onAbort = () => {
        const abortReason = options.signal?.reason;
        finish(
          {
            status: "failed",
            error:
              abortReason instanceof CodeModeHeadlessTimeoutError
                ? "code mode timeout exceeded"
                : "code mode execution aborted",
            code: abortReason instanceof CodeModeHeadlessTimeoutError ? "timeout" : "aborted",
            failurePhase: "host",
            bridgeDispatchStarted: false,
            output: [],
          },
          incompleteAttempt(),
        );
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
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
              workerData: isRecord(options.workerData)
                ? { ...options.workerData, wasmModule }
                : options.workerData,
              execArgv: sourceWorkerExecArgv,
            });
            options.onWorkerSpawned?.();
          } catch (error) {
            finish(failedCodeModeWorkerResult(error, "runtime_unavailable"));
            return;
          }

          worker.on("message", (message: unknown) => {
            if (!isRecord(message) || typeof message.kind !== "string") {
              invalidResponse();
              return;
            }
            if (message.kind === "snapshot_started") {
              if (snapshotStarted || measurement) {
                invalidResponse();
                return;
              }
              snapshotStarted = true;
              return;
            }
            if (message.kind === "snapshot_produced") {
              const observedMeasurement =
                typeof message.bytes === "number" &&
                Number.isSafeInteger(message.bytes) &&
                message.bytes >= 0 &&
                typeof message.serializationMs === "number" &&
                Number.isFinite(message.serializationMs) &&
                message.serializationMs >= 0
                  ? { bytes: message.bytes, serializationMs: message.serializationMs }
                  : undefined;
              if (!snapshotStarted || measurement || observedMeasurement === undefined) {
                invalidResponse(true, measurement ?? observedMeasurement);
                return;
              }
              measurement = observedMeasurement;
              return;
            }
            if (message.kind !== "result" || !isWorkerThreadResult(message.result, measurement)) {
              const resultClaimsSnapshot =
                isRecord(message.result) &&
                (message.result.status === "waiting" ||
                  (message.result.status === "failed" &&
                    message.result.code === "snapshot_limit_exceeded"));
              invalidResponse(snapshotStarted || resultClaimsSnapshot);
              return;
            }
            const result = normalizeCodeModeWorkerResult(message.result);
            if (result.status === "waiting") {
              if (
                !snapshotStarted ||
                !measurement ||
                maxSnapshotBytes === undefined ||
                measurement.bytes > maxSnapshotBytes
              ) {
                invalidResponse();
                return;
              }
              finish(result, snapshotAttempt("accepted", measurement));
              return;
            }
            if (result.status === "failed" && result.code === "snapshot_limit_exceeded") {
              if (
                !snapshotStarted ||
                !measurement ||
                maxSnapshotBytes === undefined ||
                measurement.bytes <= maxSnapshotBytes
              ) {
                invalidResponse();
                return;
              }
              finish(result, snapshotAttempt("rejected", measurement, "size"));
              return;
            }
            if (snapshotStarted && result.status === "completed") {
              invalidResponse();
              return;
            }
            finish(result, incompleteAttempt());
          });
          worker.once("error", (error) => {
            finish(failedCodeModeWorkerResult(error, "runtime_unavailable"), incompleteAttempt());
          });
          worker.once("exit", (code) => {
            // A clean exit without a response is still unavailable; `finish`
            // prevents normal message-then-exit from replacing a real result.
            finish(
              failedCodeModeWorkerResult(
                new Error(`code mode worker exited with code ${code} before returning a result`),
                "runtime_unavailable",
              ),
              incompleteAttempt(),
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
      options.signal?.removeEventListener("abort", onAbort);
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
