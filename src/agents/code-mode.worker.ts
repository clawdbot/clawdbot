/**
 * QuickJS worker for Code Mode guest execution and suspended VM snapshots.
 */
import { parentPort, workerData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { EvalFlags, JSException, QuickJS, type JSValueHandle } from "quickjs-wasi";
import { CODE_MODE_CONTROLLER_SOURCE } from "./code-mode-controller-source.js";
import { boundCodeModeResult, toCodeModeJsonSafe as toJsonSafe } from "./code-mode-json.js";
import type { CodeModeApiVirtualFile } from "./code-mode-namespaces.js";
import type {
  CodeModeConfig,
  CodeModeNamespaceDescriptor,
  CodeModeWorkerPayload,
  CodeModeWorkerThreadResult as CodeModeWorkerResult,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-worker-types.js";
class CodeModeWorkerFailure extends Error {
  readonly code: Extract<CodeModeWorkerResult, { status: "failed" }>["code"];

  constructor(code: Extract<CodeModeWorkerResult, { status: "failed" }>["code"], message: string) {
    super(message);
    this.name = "CodeModeWorkerFailure";
    this.code = code;
  }
}

function isQuickJsInterruptedError(error: unknown): boolean {
  return error instanceof JSException && error.message === "interrupted";
}

type VmRun = {
  vm: QuickJS;
  didTimeout: () => boolean;
};

// Each worker handles exactly one exec/resume payload, so bridge state is run-scoped.
const canceledBridgeRequestIds: string[] = [];
let bridgeAdmissionFailure: CodeModeWorkerFailure | undefined;

// QuickJS error stacks are backtrace frames only ("    at file:line:col"), with
// no leading "Name: message" header like V8. Returning .stack alone therefore
// dropped the actual cause, surfacing failures to the model as a bare location
// (e.g. "at openclaw-code-mode:user.js:2:37"). Lead with name+message so the
// model can self-correct, and keep the frames for location.
function formatQuickJsError(name: string, message: string, stack: string | undefined): string {
  const header = message ? `${name}: ${message}` : name;
  if (!stack || stack.split(/\r?\n/, 1)[0] === header) {
    return header;
  }
  return `${header}\n${stack}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof JSException) {
    return formatQuickJsError(error.name, error.message, error.stack);
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

function buildUserSource(code: string): string {
  return `globalThis.__openclawResult = (async () => {\n${code}\n})()`;
}

function createHostRequestHandler(params: {
  vm: QuickJS;
  pendingRequests: PendingBridgeRequest[];
  config: CodeModeConfig;
}): (
  this: JSValueHandle,
  method: JSValueHandle,
  argsJson: JSValueHandle,
  bridgeId?: JSValueHandle,
) => JSValueHandle {
  return (methodHandle, argsHandle, bridgeIdHandle) => {
    if (params.pendingRequests.length >= params.config.maxPendingToolCalls) {
      bridgeAdmissionFailure ??= new CodeModeWorkerFailure(
        "invalid_input",
        "too many pending code mode tool calls",
      );
      throw bridgeAdmissionFailure;
    }
    const method = methodHandle.toString();
    if (
      method !== "search" &&
      method !== "describe" &&
      method !== "callValue" &&
      method !== "nodes" &&
      method !== "yield" &&
      method !== "namespace" &&
      method !== "agentSpawn" &&
      method !== "agentWait" &&
      method !== "skillsList" &&
      method !== "skillsRead" &&
      method !== "sleep" &&
      method !== "swarmNote"
    ) {
      throw new Error("unsupported code mode bridge method");
    }
    let args: unknown;
    try {
      args = JSON.parse(argsHandle.toString()) as unknown;
    } catch {
      args = [];
    }
    // Snapshotted method counters keep launch identity independent of unrelated bridge traffic.
    // Snapshots are process-local, so every resumable guest comes from the ID-aware source above.
    const id = bridgeIdHandle?.toString();
    if (!id?.startsWith(`bridge:${method}:`) || !/^bridge:[A-Za-z]+:[1-9]\d*$/u.test(id)) {
      throw new Error("invalid code mode bridge id");
    }
    if (params.pendingRequests.some((request) => request.id === id)) {
      throw new Error("duplicate code mode bridge id");
    }
    // The guest receives only an opaque id. Host-side tool execution and policy
    // happen after the worker returns a waiting snapshot.
    params.pendingRequests.push({
      id,
      method,
      args: Array.isArray(args) ? args : [],
    });
    return params.vm.newString(id);
  };
}

function createHostCancelRequestHandler(params: {
  vm: QuickJS;
  pendingRequests: PendingBridgeRequest[];
}): (this: JSValueHandle, id: JSValueHandle) => JSValueHandle {
  return (idHandle) => {
    const id = idHandle.toString();
    const index = params.pendingRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      // Return the cancellation to the parent owner as well as removing it
      // locally; restored requests may already have a live host operation.
      params.pendingRequests.splice(index, 1);
      canceledBridgeRequestIds.push(id);
    }
    return params.vm.undefined;
  };
}

async function createVm(params: {
  wasmModule: WebAssembly.Module;
  catalog: unknown[];
  apiFiles: CodeModeApiVirtualFile[];
  namespaces: CodeModeNamespaceDescriptor[];
  swarmEnabled: boolean;
  config: CodeModeConfig;
  pendingRequests: PendingBridgeRequest[];
}): Promise<VmRun> {
  const startedAt = performance.now();
  let timedOut = false;
  const deadlineReached = () => performance.now() - startedAt >= params.config.timeoutMs;
  const vm = await QuickJS.create({
    wasm: params.wasmModule,
    memoryLimit: params.config.memoryLimitBytes,
    timezoneOffset: 0,
    interruptHandler: () => {
      timedOut = deadlineReached();
      return timedOut;
    },
  });
  vm.hostToHandle(params.catalog).consume((handle) =>
    vm.global.setProp("__openclawCatalog", handle),
  );
  vm.hostToHandle(params.namespaces).consume((handle) =>
    vm.global.setProp("__openclawNamespaces", handle),
  );
  vm.hostToHandle(params.apiFiles).consume((handle) =>
    vm.global.setProp("__openclawApiFiles", handle),
  );
  vm.hostToHandle(params.swarmEnabled).consume((handle) =>
    vm.global.setProp("__openclawSwarmEnabled", handle),
  );
  vm.newFunction(
    "__openclawHostRequest",
    createHostRequestHandler({
      vm,
      pendingRequests: params.pendingRequests,
      config: params.config,
    }),
  ).consume((hostRequest) => vm.global.setProp("__openclawHostRequest", hostRequest));
  vm.newFunction(
    "__openclawHostCancelRequest",
    createHostCancelRequestHandler({ vm, pendingRequests: params.pendingRequests }),
  ).consume((hostCancelRequest) =>
    vm.global.setProp("__openclawHostCancelRequest", hostCancelRequest),
  );
  vm.evalCode(CODE_MODE_CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
  return { vm, didTimeout: () => timedOut || deadlineReached() };
}

async function restoreVm(params: {
  wasmModule: WebAssembly.Module;
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  pendingRequests: PendingBridgeRequest[];
}): Promise<VmRun> {
  const startedAt = performance.now();
  let timedOut = false;
  const deadlineReached = () => performance.now() - startedAt >= params.config.timeoutMs;
  const snapshot = QuickJS.deserializeSnapshot(params.snapshotBytes);
  const vm = await QuickJS.restore(snapshot, {
    wasm: params.wasmModule,
    memoryLimit: params.config.memoryLimitBytes,
    timezoneOffset: 0,
    interruptHandler: () => {
      timedOut = deadlineReached();
      return timedOut;
    },
  });
  vm.registerHostCallback(
    "__openclawHostRequest",
    createHostRequestHandler({
      vm,
      pendingRequests: params.pendingRequests,
      config: params.config,
    }),
  );
  vm.registerHostCallback(
    "__openclawHostCancelRequest",
    createHostCancelRequestHandler({ vm, pendingRequests: params.pendingRequests }),
  );
  return { vm, didTimeout: () => timedOut || deadlineReached() };
}

function takeOutput(vm: QuickJS): unknown[] {
  return vm.global.getProp("__openclawTakeOutput").consume((take) =>
    vm.callFunction(take, vm.undefined).consume((output) => {
      const dumped = vm.dump(output);
      return Array.isArray(dumped) ? (dumped as unknown[]) : [];
    }),
  );
}

function takeOutputSafely(vm: QuickJS): unknown[] {
  try {
    return takeOutput(vm);
  } catch {
    return [];
  }
}

function boundWorkerResult(
  result: CodeModeWorkerResult,
  config: CodeModeConfig,
): CodeModeWorkerResult {
  const bounded = boundCodeModeResult({
    output: result.output,
    ...(result.status === "completed" ? { value: result.value } : {}),
    maxOutputBytes: config.maxOutputBytes,
  });
  if (result.status === "completed") {
    return { ...result, output: bounded.output, value: bounded.value };
  }
  return { ...result, output: bounded.output };
}

function failedWorkerResult(
  code: Extract<CodeModeWorkerResult, { status: "failed" }>["code"],
  error: string,
  output: unknown[] = [],
): Extract<CodeModeWorkerResult, { status: "failed" }> {
  return {
    status: "failed",
    code,
    error,
    failurePhase: code === "invalid_input" ? "input" : "guest",
    bridgeDispatchStarted: false,
    output,
  };
}

function workerFailureResult(params: {
  error: unknown;
  didTimeout: () => boolean;
  output: unknown[];
  vm: QuickJS;
}): CodeModeWorkerResult {
  const timedOut = params.didTimeout() || isQuickJsInterruptedError(params.error);
  const output = params.output.length > 0 ? params.output : takeOutputSafely(params.vm);
  if (timedOut) {
    return failedWorkerResult("timeout", "code mode timeout exceeded", output);
  }
  if (params.error instanceof CodeModeWorkerFailure) {
    return failedWorkerResult(params.error.code, params.error.message, output);
  }
  if (output.length > 0) {
    return failedWorkerResult("internal_error", errorMessage(params.error), output);
  }
  throw params.error;
}

async function readCompletedResult(vm: QuickJS, resultHandle: JSValueHandle): Promise<unknown> {
  if (!resultHandle.isPromise) {
    return serializeCompletedCatalogHandles(vm, resultHandle);
  }
  const settled = await vm.resolvePromise(resultHandle);
  if ("error" in settled) {
    return settled.error.consume((error) => {
      // vm.dump rebuilds a host Error carrying the QuickJS name/message/stack;
      // format it like the synchronous path so async rejections keep their cause
      // and location instead of collapsing to the bare message.
      const dumped = vm.dump(error);
      // Node module globals are deliberately absent from the WASI guest. Keep
      // aliases fail-closed at that runtime boundary rather than guessing source
      // provenance or installing a host-backed loader.
      if (
        dumped instanceof Error &&
        dumped.name === "ReferenceError" &&
        /^(?:require|module|process) is not defined$/u.test(dumped.message)
      ) {
        throw new CodeModeWorkerFailure("invalid_input", "code mode module access is disabled.");
      }
      const text =
        dumped instanceof Error
          ? formatQuickJsError(dumped.name, dumped.message, dumped.stack)
          : errorMessage(dumped);
      throw new Error(text);
    });
  }
  return settled.value.consume((value) => serializeCompletedCatalogHandles(vm, value));
}

function serializeCompletedCatalogHandles(vm: QuickJS, value: JSValueHandle): unknown {
  return vm.global
    .getProp("__openclawSerializeCatalogHandles")
    .consume((serialize) =>
      vm
        .callFunction(serialize, vm.undefined, value)
        .consume((serialized) => toJsonSafe(vm.dump(serialized))),
    );
}

function waitingResult(params: {
  vm: QuickJS;
  pendingRequests: PendingBridgeRequest[];
  settlementMode: Extract<CodeModeWorkerResult, { status: "waiting" }>["settlementMode"];
  output: unknown[];
  config: CodeModeConfig;
}): CodeModeWorkerResult {
  const snapshotBytes = QuickJS.serializeSnapshot(params.vm.snapshot());
  if (snapshotBytes.byteLength > params.config.maxSnapshotBytes) {
    throw new CodeModeWorkerFailure("snapshot_limit_exceeded", "code mode snapshot limit exceeded");
  }
  return {
    status: "waiting",
    snapshotBytes,
    pendingRequests: params.pendingRequests,
    canceledRequestIds: canceledBridgeRequestIds,
    settlementMode: params.settlementMode,
    output: params.output,
  };
}

async function runVmExecution(params: {
  vm: QuickJS;
  didTimeout: () => boolean;
  pendingRequests: PendingBridgeRequest[];
  config: CodeModeConfig;
  prepare: () => void;
}): Promise<CodeModeWorkerResult> {
  let output: unknown[] = [];
  try {
    params.prepare();
    params.vm.executePendingJobs();
    if (bridgeAdmissionFailure) {
      throw bridgeAdmissionFailure;
    }
    output = takeOutput(params.vm);
    const resultHandle = params.vm.global.getProp("__openclawResult");
    try {
      const promisePending = resultHandle.isPromise && resultHandle.promiseState === 0;
      if (promisePending && params.pendingRequests.length === 0) {
        throw new Error("code mode promise is pending without host work");
      }
      const requiredPendingRequestIds = params.pendingRequests.map((request) => request.id);
      if (promisePending || requiredPendingRequestIds.length > 0) {
        // Native await does not expose Promise ownership. Every dispatched
        // call remains required, including detached calls and race branches.
        return waitingResult({
          vm: params.vm,
          pendingRequests: params.pendingRequests,
          settlementMode: promisePending
            ? { kind: "awaiting" }
            : { kind: "draining", requiredRequestIds: requiredPendingRequestIds },
          output,
          config: params.config,
        });
      }
      const value = await readCompletedResult(params.vm, resultHandle);
      return { status: "completed", value, output };
    } finally {
      resultHandle.dispose();
    }
  } catch (error) {
    return workerFailureResult({
      error,
      didTimeout: params.didTimeout,
      output,
      vm: params.vm,
    });
  } finally {
    params.vm.dispose();
  }
}

async function runExec(input: Extract<CodeModeWorkerPayload, { kind: "exec" }>) {
  const pendingRequests: PendingBridgeRequest[] = [];
  const { vm, didTimeout } = await createVm({
    wasmModule: input.wasmModule,
    catalog: input.catalog,
    apiFiles: input.apiFiles ?? [],
    namespaces: input.namespaces,
    swarmEnabled: input.swarmEnabled === true,
    config: input.config,
    pendingRequests,
  });
  return runVmExecution({
    vm,
    didTimeout,
    pendingRequests,
    config: input.config,
    prepare: () => {
      vm.evalCode(
        buildUserSource(input.source),
        "openclaw-code-mode:user.js",
        EvalFlags.ASYNC,
      ).dispose();
    },
  });
}

async function runResume(input: Extract<CodeModeWorkerPayload, { kind: "resume" }>) {
  // Restored promises keep their original bridge ids; do not redispatch calls
  // that are still running when a faster sibling resumes this snapshot.
  const pendingRequests: PendingBridgeRequest[] = [...(input.pendingRequests ?? [])];
  const { vm, didTimeout } = await restoreVm({
    wasmModule: input.wasmModule,
    snapshotBytes: input.snapshotBytes,
    config: input.config,
    pendingRequests,
  });
  return runVmExecution({
    vm,
    didTimeout,
    pendingRequests,
    config: input.config,
    prepare: () => {
      vm.global.getProp("__openclawSettleBridge").consume((settle) => {
        for (const request of input.settledRequests) {
          const id = vm.newString(request.id);
          const payload = vm.newString(JSON.stringify(request.ok ? request.value : request.error));
          try {
            vm.callFunction(
              settle,
              vm.undefined,
              id,
              request.ok ? vm.true : vm.false,
              payload,
            ).dispose();
          } finally {
            id.dispose();
            payload.dispose();
          }
        }
      });
    },
  });
}

function isQuickJsWasmModule(value: unknown): value is WebAssembly.Module {
  return Object.prototype.toString.call(value) === "[object WebAssembly.Module]";
}

async function main(): Promise<CodeModeWorkerResult> {
  const input = workerData as unknown;
  if (!isRecord(input) || !isRecord(input.config) || !isQuickJsWasmModule(input.wasmModule)) {
    return failedWorkerResult("invalid_input", "invalid code mode worker input");
  }
  const config = input.config as CodeModeConfig;
  try {
    if (input.kind === "exec" && typeof input.source === "string") {
      return boundWorkerResult(
        await runExec({
          kind: "exec",
          wasmModule: input.wasmModule,
          source: input.source,
          config,
          catalog: Array.isArray(input.catalog) ? input.catalog : [],
          apiFiles: Array.isArray(input.apiFiles)
            ? (input.apiFiles as CodeModeApiVirtualFile[])
            : [],
          namespaces: Array.isArray(input.namespaces)
            ? (input.namespaces as CodeModeNamespaceDescriptor[])
            : [],
          swarmEnabled: input.swarmEnabled === true,
        }),
        config,
      );
    }
    if (input.kind === "resume" && input.snapshotBytes instanceof Uint8Array) {
      return boundWorkerResult(
        await runResume({
          kind: "resume",
          wasmModule: input.wasmModule,
          snapshotBytes: input.snapshotBytes,
          config,
          settledRequests: Array.isArray(input.settledRequests)
            ? (input.settledRequests as SettledBridgeRequest[])
            : [],
          pendingRequests: Array.isArray(input.pendingRequests)
            ? (input.pendingRequests as PendingBridgeRequest[])
            : [],
        }),
        config,
      );
    }
    return failedWorkerResult("invalid_input", "invalid code mode worker input");
  } catch (error) {
    const timedOut = isQuickJsInterruptedError(error);
    const code = timedOut
      ? "timeout"
      : error instanceof CodeModeWorkerFailure
        ? error.code
        : "internal_error";
    return failedWorkerResult(code, timedOut ? "code mode timeout exceeded" : errorMessage(error));
  }
}

if (parentPort) {
  Reflect.apply(Reflect.get(parentPort, "postMessage") as (message: unknown) => void, parentPort, [
    await main(),
  ]);
}
