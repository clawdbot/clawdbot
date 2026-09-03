/**
 * QuickJS worker for Code Mode guest execution and suspended VM snapshots.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { EvalFlags, JSException, QuickJS, type JSValueHandle, type Snapshot } from "quickjs-wasi";
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import { CODE_MODE_CONTROLLER_SOURCE } from "./code-mode-controller-source.js";
import {
  boundCodeModeError,
  captureCodeModeOutput,
  captureCodeModeValue,
  EMPTY_CODE_MODE_OUTPUT,
} from "./code-mode-json.js";
import type { CodeModeApiVirtualFile } from "./code-mode-namespaces.js";
import { prepareSource } from "./code-mode-source.js";
import type {
  CodeModeConfig,
  CodeModeLanguage,
  CodeModeNamespaceDescriptor,
  CodeModeWorkerPayload,
  CodeModeVmResult as CodeModeWorkerResult,
  CodeModeWorkerThreadResult,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-worker-types.js";
import { ToolInputError } from "./tool-input-error.js";
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

// Workers are reusable; every VM owns its own bridge state, including failures
// and cancellations, so a later session cannot inherit a previous run's state.
type BridgeState = {
  pendingRequests: PendingBridgeRequest[];
  canceledRequestIds: string[];
  admissionFailure?: CodeModeWorkerFailure;
};

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

function trackPromiseRejection(
  promise: JSValueHandle,
  reason: JSValueHandle,
  handled: boolean,
): void {
  const vm = promise.vm;
  vm.global
    .getProp("__openclawTrackRejection")
    .consume((track) =>
      vm.callFunction(track, vm.undefined, promise, reason, handled ? vm.true : vm.false).dispose(),
    );
}

function createHostRequestHandler(params: {
  vm: QuickJS;
  bridge: BridgeState;
  config: CodeModeConfig;
}): (
  this: JSValueHandle,
  method: JSValueHandle,
  argsJson: JSValueHandle,
  bridgeId?: JSValueHandle,
) => JSValueHandle {
  return (methodHandle, argsHandle, bridgeIdHandle) => {
    if (params.bridge.pendingRequests.length >= params.config.maxPendingToolCalls) {
      params.bridge.admissionFailure ??= new CodeModeWorkerFailure(
        "invalid_input",
        "too many pending code mode tool calls",
      );
      throw params.bridge.admissionFailure;
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
    if (params.bridge.pendingRequests.some((request) => request.id === id)) {
      throw new Error("duplicate code mode bridge id");
    }
    // The guest receives only an opaque id. Host-side tool execution and policy
    // happen after the worker returns a waiting snapshot.
    params.bridge.pendingRequests.push({
      id,
      method,
      args: Array.isArray(args) ? args : [],
    });
    return params.vm.newString(id);
  };
}

function createHostCancelRequestHandler(params: {
  vm: QuickJS;
  bridge: BridgeState;
}): (this: JSValueHandle, id: JSValueHandle) => JSValueHandle {
  return (idHandle) => {
    const id = idHandle.toString();
    const index = params.bridge.pendingRequests.findIndex((request) => request.id === id);
    if (index >= 0) {
      // Return the cancellation to the parent owner as well as removing it
      // locally; restored requests may already have a live host operation.
      params.bridge.pendingRequests.splice(index, 1);
      params.bridge.canceledRequestIds.push(id);
    }
    return params.vm.undefined;
  };
}

async function createVm(input: CodeModeWorkerPayload, bridge: BridgeState): Promise<VmRun> {
  const startedAt = performance.now();
  let timedOut = false;
  const deadlineReached = () => performance.now() - startedAt >= input.config.timeoutMs;
  const options = {
    wasm: input.wasmModule,
    memoryLimit: input.config.memoryLimitBytes,
    timezoneOffset: 0,
    onUnhandledRejection: trackPromiseRejection,
    interruptHandler: () => {
      timedOut = deadlineReached();
      return timedOut;
    },
  };
  const vm =
    input.kind === "resume"
      ? await QuickJS.restore(input.snapshot, options)
      : await QuickJS.create(options);
  try {
    const callbacks = [
      ["__openclawHostRequest", createHostRequestHandler({ vm, bridge, config: input.config })],
      ["__openclawHostCancelRequest", createHostCancelRequestHandler({ vm, bridge })],
    ] as const;
    for (const [name, callback] of callbacks) {
      if (input.kind === "resume") {
        // The snapshot owns the original function identities. Rebind callbacks
        // by name without recreating globals the controller deliberately hides.
        vm.registerHostCallback(name, callback);
      } else {
        vm.newFunction(name, callback).consume((handle) => vm.global.setProp(name, handle));
      }
    }
    if (input.kind === "exec") {
      for (const [name, value] of [
        ["__openclawCatalog", input.catalog],
        ["__openclawNamespaces", input.namespaces],
        ["__openclawApiFiles", input.apiFiles ?? []],
        ["__openclawSwarmEnabled", input.swarmEnabled === true],
        ["__openclawMaxPendingToolCalls", input.config.maxPendingToolCalls],
      ] as const) {
        vm.hostToHandle(value).consume((handle) => vm.global.setProp(name, handle));
      }
      vm.evalCode(CODE_MODE_CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
    }
    return { vm, didTimeout: () => timedOut || deadlineReached() };
  } catch (error) {
    vm.dispose();
    throw error;
  }
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

function captureWorkerResult(
  result: CodeModeWorkerResult,
  config: CodeModeConfig,
): CodeModeWorkerThreadResult {
  const output = captureCodeModeOutput(result.output, config.maxOutputBytes);
  if (result.status === "completed") {
    return { ...result, output, value: captureCodeModeValue(result.value, config.maxOutputBytes) };
  }
  return result.status === "failed"
    ? { ...result, output, error: boundCodeModeError(result.error, config.maxOutputBytes) }
    : { ...result, output };
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
      vm.callFunction(serialize, vm.undefined, value).consume((serialized) => vm.dump(serialized)),
    );
}

function waitingResult(params: {
  vm: QuickJS;
  bridge: BridgeState;
  settlementMode: Extract<CodeModeWorkerResult, { status: "waiting" }>["settlementMode"];
  output: unknown[];
  config: CodeModeConfig;
}): CodeModeWorkerResult {
  const snapshot = params.vm.snapshot();
  // Preserve the encoded-size cap, but serialize only metadata: the snapshot
  // already owns transferable memory, so the storage codec would copy it again.
  const metadata = QuickJS.serializeSnapshot({ ...snapshot, memory: new Uint8Array() });
  if (snapshot.memory.byteLength + metadata.byteLength > params.config.maxSnapshotBytes) {
    throw new CodeModeWorkerFailure("snapshot_limit_exceeded", "code mode snapshot limit exceeded");
  }
  return {
    status: "waiting",
    snapshot,
    pendingRequests: params.bridge.pendingRequests,
    canceledRequestIds: params.bridge.canceledRequestIds,
    settlementMode: params.settlementMode,
    output: params.output,
  };
}

async function runVmExecution(params: {
  vm: QuickJS;
  didTimeout: () => boolean;
  bridge: BridgeState;
  config: CodeModeConfig;
  prepare: () => void;
}): Promise<CodeModeWorkerResult> {
  let output: unknown[] = [];
  try {
    params.prepare();
    params.vm.executePendingJobs();
    if (params.bridge.admissionFailure) {
      throw params.bridge.admissionFailure;
    }
    output = takeOutput(params.vm);
    const resultHandle = params.vm.global.getProp("__openclawResult");
    try {
      const promisePending = resultHandle.isPromise && resultHandle.promiseState === 0;
      if (promisePending && params.bridge.pendingRequests.length === 0) {
        throw new Error("code mode promise is pending without host work");
      }
      const requiredPendingRequestIds = params.bridge.pendingRequests.map((request) => request.id);
      if (promisePending || requiredPendingRequestIds.length > 0) {
        // Native await does not expose Promise ownership. Every dispatched
        // call remains required, including detached calls and race branches.
        return waitingResult({
          vm: params.vm,
          bridge: params.bridge,
          settlementMode: promisePending
            ? { kind: "awaiting" }
            : { kind: "draining", requiredRequestIds: requiredPendingRequestIds },
          output,
          config: params.config,
        });
      }
      const value = await readCompletedResult(params.vm, resultHandle);
      // Check only after all host work and microtasks settle. Catches attached
      // after an await (including a restored snapshot) still own their errors.
      using rejection = params.vm.global
        .getProp("__openclawUnhandledRejection")
        .consume((read) => params.vm.callFunction(read, params.vm.undefined));
      await readCompletedResult(params.vm, rejection);
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

async function run(input: CodeModeWorkerPayload): Promise<CodeModeWorkerResult> {
  const startedAt = performance.now();
  const source =
    input.kind === "exec"
      ? await prepareSource({ code: input.source, language: input.language, config: input.config })
      : "";
  const config = {
    ...input.config,
    timeoutMs: Math.min(
      input.config.timeoutMs - (performance.now() - startedAt),
      input.kind === "exec" ? (input.executionTimeoutMs ?? Infinity) : Infinity,
    ),
  };
  if (config.timeoutMs <= 0) {
    throw new CodeModeWorkerFailure("timeout", "code mode timeout exceeded");
  }
  // Restored promises retain bridge IDs; unresolved siblings are not redispatched.
  const bridge: BridgeState = {
    pendingRequests: input.kind === "resume" ? [...(input.pendingRequests ?? [])] : [],
    canceledRequestIds: [],
  };
  const { vm, didTimeout } = await createVm({ ...input, config }, bridge);
  return runVmExecution({
    vm,
    didTimeout,
    bridge,
    config,
    prepare: () => {
      if (input.kind === "exec") {
        vm.evalCode(
          buildUserSource(`${input.prelude ?? ""}${source}`),
          "openclaw-code-mode:user.js",
          EvalFlags.ASYNC,
        ).dispose();
        return;
      }
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

async function main(input: unknown): Promise<CodeModeWorkerThreadResult> {
  if (!isRecord(input) || !isRecord(input.config) || !isQuickJsWasmModule(input.wasmModule)) {
    return {
      ...failedWorkerResult("invalid_input", "invalid code mode worker input"),
      output: EMPTY_CODE_MODE_OUTPUT,
    };
  }
  const config = input.config as CodeModeConfig;
  try {
    if (config.timeoutMs <= 0) {
      throw new CodeModeWorkerFailure("timeout", "code mode timeout exceeded");
    }
    if (input.kind === "exec" && typeof input.source === "string") {
      return captureWorkerResult(
        await run({
          kind: "exec",
          wasmModule: input.wasmModule,
          source: input.source,
          language: input.language as CodeModeLanguage | undefined,
          prelude: typeof input.prelude === "string" ? input.prelude : undefined,
          executionTimeoutMs:
            typeof input.executionTimeoutMs === "number" ? input.executionTimeoutMs : undefined,
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
    // SAFETY: This process's QuickJS workers produce snapshots; the host returns them unchanged.
    const snapshot = input.snapshot as Snapshot | undefined;
    if (input.kind === "resume" && snapshot?.memory instanceof Uint8Array) {
      return captureWorkerResult(
        await run({
          kind: "resume",
          wasmModule: input.wasmModule,
          snapshot,
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
    return {
      ...failedWorkerResult("invalid_input", "invalid code mode worker input"),
      output: EMPTY_CODE_MODE_OUTPUT,
    };
  } catch (error) {
    const timedOut = isQuickJsInterruptedError(error);
    const code = timedOut
      ? "timeout"
      : error instanceof CodeModeWorkerFailure
        ? error.code
        : error instanceof ToolInputError
          ? "invalid_input"
          : "internal_error";
    return captureWorkerResult(
      failedWorkerResult(code, timedOut ? "code mode timeout exceeded" : errorMessage(error)),
      config,
    );
  }
}

serveWorkerTasks(main, {
  transferList: (result) =>
    // SAFETY: QuickJS.snapshot allocates a dedicated, transferable ArrayBuffer.
    result.status === "waiting" ? [result.snapshot.memory.buffer as ArrayBuffer] : [],
});
