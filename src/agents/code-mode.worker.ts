/**
 * QuickJS worker for Code Mode guest execution and suspended VM snapshots.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { EvalFlags, JSException, QuickJS, type JSValueHandle } from "quickjs-wasi";
import type { CodeModeApiVirtualFile } from "./code-mode-namespaces.js";
const require = createRequire(import.meta.url);
const QUICKJS_WASM_PATH = require.resolve("quickjs-wasi/quickjs.wasm");
let quickJsWasmModulePromise: Promise<WebAssembly.Module> | undefined;

type CodeModeBridgeMethod = "search" | "describe" | "call" | "yield" | "namespace";

type CodeModeConfig = {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxPendingToolCalls: number;
  maxSnapshotBytes: number;
};

type PendingBridgeRequest = {
  id: string;
  method: CodeModeBridgeMethod;
  args: unknown[];
};

type SettledBridgeRequest = { id: string } & Result<unknown, string>;

type SerializedCodeModeNamespaceValue =
  | { kind: "array"; items: SerializedCodeModeNamespaceValue[] }
  | { kind: "function"; path: string[] }
  | { kind: "object"; entries: Array<[string, SerializedCodeModeNamespaceValue]> }
  | { kind: "value"; value: unknown };

type CodeModeNamespaceDescriptor = {
  id: string;
  globalName: string;
  description?: string;
  scope: SerializedCodeModeNamespaceValue;
};

type CodeModeWorkerInput =
  | {
      kind: "exec";
      source: string;
      config: CodeModeConfig;
      catalog: unknown[];
      apiFiles?: CodeModeApiVirtualFile[];
      namespaces: CodeModeNamespaceDescriptor[];
    }
  | {
      kind: "resume";
      snapshotBytes: Uint8Array;
      config: CodeModeConfig;
      settledRequests: SettledBridgeRequest[];
    };

type CodeModeWorkerResult =
  | {
      status: "completed";
      value: unknown;
      output: unknown[];
    }
  | {
      status: "waiting";
      snapshotBytes: Uint8Array;
      pendingRequests: PendingBridgeRequest[];
      output: unknown[];
    }
  | {
      status: "failed";
      error: string;
      code:
        | "invalid_input"
        | "runtime_unavailable"
        | "timeout"
        | "snapshot_limit_exceeded"
        | "internal_error";
      output: unknown[];
    };

class CodeModeWorkerFailure extends Error {
  readonly code: Extract<CodeModeWorkerResult, { status: "failed" }>["code"];

  constructor(
    code: Extract<CodeModeWorkerResult, { status: "failed" }>["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeModeWorkerFailure";
    this.code = code;
  }
}

class CodeModeWorkerFailureWithOutput extends CodeModeWorkerFailure {
  readonly output: unknown[];

  constructor(
    code: Extract<CodeModeWorkerResult, { status: "failed" }>["code"],
    message: string,
    output: unknown[],
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "CodeModeWorkerFailureWithOutput";
    this.output = output;
  }
}

class CodeModeGuestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeModeGuestError";
  }
}

function isQuickJsInterruptedError(error: unknown): boolean {
  if (error instanceof CodeModeGuestError) {
    return false;
  }
  // Match on the raw QuickJS message, not the formatted errorMessage() string,
  // which now leads with the error name and appends backtrace frames.
  if (error instanceof JSException) {
    return error.message === "interrupted";
  }
  return errorMessage(error) === "interrupted";
}

type VmRun = {
  vm: QuickJS;
  didTimeout: () => boolean;
};

function getQuickJsWasmModule(): Promise<WebAssembly.Module> {
  quickJsWasmModulePromise ??= readFile(QUICKJS_WASM_PATH).then((bytes) =>
    WebAssembly.compile(bytes),
  );
  return quickJsWasmModulePromise;
}

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

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return value;
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

const CONTROLLER_SOURCE = String.raw`
(() => {
  const output = [];
  const pending = new Map();
  const catalog = Array.isArray(globalThis.__openclawCatalog) ? globalThis.__openclawCatalog : [];
  const apiFiles = Array.isArray(globalThis.__openclawApiFiles) ? globalThis.__openclawApiFiles : [];
  const namespaceDescriptors = Array.isArray(globalThis.__openclawNamespaces) ? globalThis.__openclawNamespaces : [];

  function safe(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      if (value instanceof Error) {
        return { name: value.name, message: value.message };
      }
      if (value === null) return null;
      const type = typeof value;
      if (type === "string" || type === "number" || type === "boolean") return value;
      return String(value);
    }
  }

  function asText(value) {
    if (typeof value === "string") return value;
    const encoded = JSON.stringify(safe(value));
    return typeof encoded === "string" ? encoded : String(value);
  }

  function request(method, args) {
    const id = String(globalThis.__openclawHostRequest(String(method), JSON.stringify(safe(args ?? []))));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function namespaceFunction(namespaceId, path) {
    const callablePath = Object.freeze((Array.isArray(path) ? path : []).map((entry) => String(entry)));
    return (...args) => request("namespace", [namespaceId, callablePath, args]);
  }

  function deserializeNamespaceValue(namespaceId, value) {
    if (!value || typeof value !== "object") return null;
    if (value.kind === "function") {
      return namespaceFunction(namespaceId, Array.isArray(value.path) ? value.path.slice() : []);
    }
    if (value.kind === "array") {
      return Object.freeze((Array.isArray(value.items) ? value.items : []).map((item) => deserializeNamespaceValue(namespaceId, item)));
    }
    if (value.kind === "object") {
      const object = Object.create(null);
      for (const entry of Array.isArray(value.entries) ? value.entries : []) {
        const key = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
        if (!key) continue;
        Object.defineProperty(object, key, {
          value: deserializeNamespaceValue(namespaceId, entry[1]),
          enumerable: true,
        });
      }
      return Object.freeze(object);
    }
    return safe(value.value);
  }

  function settle(id, ok, payload) {
    const entry = pending.get(String(id));
    if (!entry) return false;
    pending.delete(String(id));
    let parsed = null;
    try {
      parsed = JSON.parse(String(payload));
    } catch {
      parsed = String(payload);
    }
    if (ok) {
      entry.resolve(parsed);
    } else {
      const error = new Error(typeof parsed === "string" ? parsed : parsed?.message ?? "nested tool failed");
      entry.reject(error);
    }
    return true;
  }

  const baseTools = Object.create(null);
  Object.defineProperties(baseTools, {
    search: { value: (query, options) => request("search", [query, options]), enumerable: true },
    describe: { value: (id) => request("describe", [id]), enumerable: true },
    call: { value: (id, input) => request("call", [id, input]), enumerable: true },
  });

  function normalizeApiPath(value) {
    const text = String(value ?? "").trim().replace(/^\/+/, "");
    if (!text || text.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("invalid API file path");
    }
    return text;
  }

  const apiFileMap = new Map();
  for (const file of apiFiles) {
    if (!file || typeof file !== "object") continue;
    const path = typeof file.path === "string" ? file.path : "";
    const content = typeof file.content === "string" ? file.content : "";
    if (!path || !content) continue;
    apiFileMap.set(path, Object.freeze({
      path,
      content,
      description: typeof file.description === "string" ? file.description : undefined,
      bytes: file.bytes,
    }));
  }
  const api = Object.freeze({
    list: async (prefix = "") => {
      const normalizedPrefix = prefix == null || String(prefix).trim() === "" ? "" : normalizeApiPath(prefix);
      const files = [...apiFileMap.values()]
        .filter((file) => !normalizedPrefix || file.path === normalizedPrefix || file.path.startsWith(normalizedPrefix.replace(/\/?$/, "/")))
        .map((file) => Object.freeze({
          path: file.path,
          description: file.description,
          bytes: file.bytes,
        }));
      return { files };
    },
    read: async (path) => {
      const normalizedPath = normalizeApiPath(path);
      const file = apiFileMap.get(normalizedPath);
      if (!file) throw new Error("Unknown API file: " + normalizedPath);
      return file;
    },
  });

  const safeNameCounts = new Map();
  for (const tool of catalog) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
    safeNameCounts.set(name, (safeNameCounts.get(name) ?? 0) + 1);
  }
  for (const tool of catalog) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    const id = typeof tool?.id === "string" ? tool.id : "";
    if (!id || safeNameCounts.get(name) !== 1 || Object.prototype.hasOwnProperty.call(baseTools, name)) {
      continue;
    }
    Object.defineProperty(baseTools, name, {
      value: (input) => request("call", [id, input]),
      enumerable: true,
    });
  }

  const namespaceGlobals = Object.create(null);
  for (const descriptor of namespaceDescriptors) {
    const id = typeof descriptor?.id === "string" ? descriptor.id : "";
    const globalName = typeof descriptor?.globalName === "string" ? descriptor.globalName : "";
    if (!id || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(globalName)) continue;
    const scope = deserializeNamespaceValue(id, descriptor.scope);
    Object.defineProperty(namespaceGlobals, globalName, {
      value: scope,
      enumerable: true,
    });
    const existingGlobal = Object.getOwnPropertyDescriptor(globalThis, globalName);
    if (existingGlobal && existingGlobal.configurable === false) continue;
    Object.defineProperty(globalThis, globalName, {
      value: scope,
      enumerable: true,
      configurable: true,
    });
  }

  Object.defineProperties(globalThis, {
    ALL_TOOLS: { value: Object.freeze(catalog.slice()), enumerable: true },
    API: { value: api, enumerable: true },
    namespaces: { value: Object.freeze(namespaceGlobals), enumerable: true },
    tools: { value: Object.freeze(baseTools), enumerable: true },
    text: { value: (value) => output.push({ type: "text", text: asText(value) }), enumerable: true },
    json: { value: (value) => output.push({ type: "json", value: safe(value) }), enumerable: true },
    yield_control: { value: (reason) => request("yield", [reason]), enumerable: true },
    __openclawSettleBridge: { value: settle },
    __openclawTakeOutput: { value: () => output.splice(0) },
  });
})();
`;

function buildUserSource(code: string): string {
  return `globalThis.__openclawResult = (async () => {\n${code}\n})()`;
}

function createHostRequestHandler(params: {
  vm: QuickJS;
  pendingRequests: PendingBridgeRequest[];
  config: CodeModeConfig;
}): (this: JSValueHandle, method: JSValueHandle, argsJson: JSValueHandle) => JSValueHandle {
  return (methodHandle, argsHandle) => {
    if (params.pendingRequests.length >= params.config.maxPendingToolCalls) {
      throw new Error("too many pending code mode tool calls");
    }
    const method = methodHandle.toString();
    if (
      method !== "search" &&
      method !== "describe" &&
      method !== "call" &&
      method !== "yield" &&
      method !== "namespace"
    ) {
      throw new Error("unsupported code mode bridge method");
    }
    let args: unknown;
    try {
      args = JSON.parse(argsHandle.toString()) as unknown;
    } catch {
      args = [];
    }
    const id = `bridge:${params.pendingRequests.length + 1}:${randomUUID()}`;
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

async function createVm(params: {
  catalog: unknown[];
  apiFiles: CodeModeApiVirtualFile[];
  namespaces: CodeModeNamespaceDescriptor[];
  config: CodeModeConfig;
  pendingRequests: PendingBridgeRequest[];
}): Promise<VmRun> {
  const startedAt = Date.now();
  let timedOut = false;
  const deadlineReached = () => Date.now() - startedAt >= params.config.timeoutMs;
  const vm = await QuickJS.create({
    wasm: await getQuickJsWasmModule(),
    memoryLimit: params.config.memoryLimitBytes,
    timezoneOffset: 0,
    interruptHandler: () => {
      timedOut = deadlineReached();
      return timedOut;
    },
  });
  const catalogHandle = vm.hostToHandle(params.catalog);
  try {
    vm.setProp(vm.global, "__openclawCatalog", catalogHandle);
  } finally {
    catalogHandle.dispose();
  }
  const namespacesHandle = vm.hostToHandle(params.namespaces);
  try {
    vm.setProp(vm.global, "__openclawNamespaces", namespacesHandle);
  } finally {
    namespacesHandle.dispose();
  }
  const apiFilesHandle = vm.hostToHandle(params.apiFiles);
  try {
    vm.setProp(vm.global, "__openclawApiFiles", apiFilesHandle);
  } finally {
    apiFilesHandle.dispose();
  }
  const hostRequest = vm.newFunction(
    "__openclawHostRequest",
    createHostRequestHandler({
      vm,
      pendingRequests: params.pendingRequests,
      config: params.config,
    }),
  );
  try {
    vm.setProp(vm.global, "__openclawHostRequest", hostRequest);
  } finally {
    hostRequest.dispose();
  }
  vm.evalCode(CONTROLLER_SOURCE, "openclaw-code-mode:controller.js").dispose();
  return { vm, didTimeout: () => timedOut || deadlineReached() };
}

async function restoreVm(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  pendingRequests: PendingBridgeRequest[];
}): Promise<VmRun> {
  const startedAt = Date.now();
  let timedOut = false;
  const deadlineReached = () => Date.now() - startedAt >= params.config.timeoutMs;
  const snapshot = QuickJS.deserializeSnapshot(params.snapshotBytes);
  const vm = await QuickJS.restore(snapshot, {
    wasm: await getQuickJsWasmModule(),
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
  return { vm, didTimeout: () => timedOut || deadlineReached() };
}

function takeOutput(vm: QuickJS): unknown[] {
  const take = vm.global.getProp("__openclawTakeOutput");
  try {
    const output = vm.callFunction(take, vm.undefined);
    try {
      const dumped = vm.dump(output);
      return Array.isArray(dumped) ? (dumped as unknown[]) : [];
    } finally {
      output.dispose();
    }
  } finally {
    take.dispose();
  }
}

function takeOutputSafely(vm: QuickJS): unknown[] {
  try {
    return takeOutput(vm);
  } catch {
    return [];
  }
}

function throwWorkerFailureWithOutput(params: {
  error: unknown;
  didTimeout: () => boolean;
  output: unknown[];
  vm: QuickJS;
}): never {
  const timedOut = params.didTimeout() || isQuickJsInterruptedError(params.error);
  const failureOutput = params.output.length > 0 ? params.output : takeOutputSafely(params.vm);
  if (timedOut) {
    throw new CodeModeWorkerFailureWithOutput(
      "timeout",
      "code mode timeout exceeded",
      failureOutput,
      { cause: params.error },
    );
  }
  if (params.error instanceof CodeModeWorkerFailure) {
    throw new CodeModeWorkerFailureWithOutput(
      params.error.code,
      params.error.message,
      failureOutput,
      { cause: params.error },
    );
  }
  if (failureOutput.length > 0) {
    throw new CodeModeWorkerFailureWithOutput(
      "internal_error",
      errorMessage(params.error),
      failureOutput,
      { cause: params.error },
    );
  }
  throw params.error;
}

async function readCompletedResult(vm: QuickJS, resultHandle: JSValueHandle): Promise<unknown> {
  if (!resultHandle.isPromise) {
    return toJsonSafe(vm.dump(resultHandle));
  }
  const settled = await vm.resolvePromise(resultHandle);
  if ("error" in settled) {
    try {
      // vm.dump rebuilds a host Error carrying the QuickJS name/message/stack;
      // format it like the synchronous path so async rejections keep their cause
      // and location instead of collapsing to the bare message.
      const dumped = vm.dump(settled.error);
      const text =
        dumped instanceof Error
          ? formatQuickJsError(dumped.name, dumped.message, dumped.stack)
          : errorMessage(dumped);
      throw new CodeModeGuestError(text);
    } finally {
      settled.error.dispose();
    }
  }
  try {
    return toJsonSafe(vm.dump(settled.value));
  } finally {
    settled.value.dispose();
  }
}

function waitingResult(params: {
  vm: QuickJS;
  pendingRequests: PendingBridgeRequest[];
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
    output = takeOutput(params.vm);
    const resultHandle = params.vm.global.getProp("__openclawResult");
    try {
      if (params.pendingRequests.length > 0) {
        // Pending host work suspends the VM instead of blocking in-worker; the
        // host resumes with settled bridge results via runResume.
        return waitingResult({
          vm: params.vm,
          pendingRequests: params.pendingRequests,
          output,
          config: params.config,
        });
      }
      if (resultHandle.isPromise && resultHandle.promiseState === 0) {
        throw new Error("code mode promise is pending without host work");
      }
      return {
        status: "completed",
        value: await readCompletedResult(params.vm, resultHandle),
        output,
      };
    } finally {
      resultHandle.dispose();
    }
  } catch (error) {
    return throwWorkerFailureWithOutput({
      error,
      didTimeout: params.didTimeout,
      output,
      vm: params.vm,
    });
  } finally {
    params.vm.dispose();
  }
}

async function runExec(input: Extract<CodeModeWorkerInput, { kind: "exec" }>) {
  const pendingRequests: PendingBridgeRequest[] = [];
  const { vm, didTimeout } = await createVm({
    catalog: input.catalog,
    apiFiles: input.apiFiles ?? [],
    namespaces: input.namespaces,
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

async function runResume(input: Extract<CodeModeWorkerInput, { kind: "resume" }>) {
  const pendingRequests: PendingBridgeRequest[] = [];
  const { vm, didTimeout } = await restoreVm({
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
      const settle = vm.global.getProp("__openclawSettleBridge");
      try {
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
      } finally {
        settle.dispose();
      }
    },
  });
}

async function main(): Promise<CodeModeWorkerResult> {
  const input = workerData as unknown;
  if (!isRecord(input) || !isRecord(input.config)) {
    return {
      status: "failed",
      error: "invalid code mode worker input",
      code: "invalid_input",
      output: [],
    };
  }
  try {
    if (input.kind === "exec" && typeof input.source === "string") {
      return await runExec({
        kind: "exec",
        source: input.source,
        config: input.config as CodeModeConfig,
        catalog: Array.isArray(input.catalog) ? input.catalog : [],
        apiFiles: Array.isArray(input.apiFiles) ? (input.apiFiles as CodeModeApiVirtualFile[]) : [],
        namespaces: Array.isArray(input.namespaces)
          ? (input.namespaces as CodeModeNamespaceDescriptor[])
          : [],
      });
    }
    if (input.kind === "resume" && input.snapshotBytes instanceof Uint8Array) {
      return await runResume({
        kind: "resume",
        snapshotBytes: input.snapshotBytes,
        config: input.config as CodeModeConfig,
        settledRequests: Array.isArray(input.settledRequests)
          ? (input.settledRequests as SettledBridgeRequest[])
          : [],
      });
    }
    return {
      status: "failed",
      error: "invalid code mode worker input",
      code: "invalid_input",
      output: [],
    };
  } catch (error) {
    const timedOut = isQuickJsInterruptedError(error);
    return {
      status: "failed",
      error: timedOut ? "code mode timeout exceeded" : errorMessage(error),
      code: timedOut
        ? "timeout"
        : error instanceof CodeModeWorkerFailure
          ? error.code
          : "internal_error",
      output: error instanceof CodeModeWorkerFailureWithOutput ? error.output : [],
    };
  }
}

if (parentPort) {
  Reflect.apply(Reflect.get(parentPort, "postMessage") as (message: unknown) => void, parentPort, [
    await main(),
  ]);
}
