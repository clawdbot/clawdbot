/** Sandboxed guest globals and host bridge for Code Mode QuickJS cells. */
import { CODE_MODE_CONSOLE_SOURCE } from "./code-mode-console-source.js";
import { CODE_MODE_SWARM_CONTROLLER_SOURCE } from "./code-mode-swarm-controller-source.js";
import { MAX_CODE_MODE_PENDING_TOOL_CALLS } from "./code-mode-worker-types.js";

export const CODE_MODE_CONTROLLER_SOURCE = String.raw`
(() => {
  const output = [];
  const pending = new Map();
  const queued = new Map();
  // Only ordinary requests use this quota. Swarm retains its group/VM bounds
  // while sharing the same ordered queue and in-flight slots.
  const maxQueuedOrdinary = ${MAX_CODE_MODE_PENDING_TOOL_CALLS};
  let queuedOrdinaryCount = 0;
  let admissionError;
  const maxPending = globalThis.__openclawMaxPendingToolCalls;
  delete globalThis.__openclawMaxPendingToolCalls;
  const catalogBindings = Array.isArray(globalThis.__openclawCatalog) ? globalThis.__openclawCatalog : [];
  const apiFiles = Array.isArray(globalThis.__openclawApiFiles) ? globalThis.__openclawApiFiles : [];
  const namespaceDescriptors = Array.isArray(globalThis.__openclawNamespaces) ? globalThis.__openclawNamespaces : [];
  const hostRequest = globalThis.__openclawHostRequest;
  const hostCancelRequest = globalThis.__openclawHostCancelRequest;
  delete globalThis.__openclawHostRequest;
  delete globalThis.__openclawHostCancelRequest;
  delete globalThis.__openclawCatalog;
  delete globalThis.__openclawApiFiles;
  delete globalThis.__openclawNamespaces;
  const bridgeSequences = new Map();
  const timers = new Map();
  // Keep rejection ownership in the snapshot so a handler attached after wait
  // can clear it; an unawaited failure must not become a successful cell.
  const unhandledRejections = new Map();
  let nextTimerId = 0;
  const GuestPromise = Promise;
  const GuestError = Error;
  const promiseOutput = "[Unawaited Promise: use await or Promise.all(...) before emitting or returning values.]";

  ${CODE_MODE_CONSOLE_SOURCE}

  function safe(value, diagnosePromises = false) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(diagnosePromises ? serializeOutputValue(value) : value));
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
    const encoded = JSON.stringify(safe(value, true));
    return typeof encoded === "string" ? encoded : String(value);
  }

  function assertQueueCapacity(queue) {
    if (!admissionError && !queue && pending.size >= maxPending && queuedOrdinaryCount >= maxQueuedOrdinary) {
      admissionError = "code mode bridge queue limit exceeded (" + maxQueuedOrdinary + " ordinary requests queued; " + maxPending + " in-flight slots). Await smaller batches before creating more tool calls or timers.";
    }
    // Sticky even if guest code catches the immediate error: the worker refuses
    // this entire synchronous frontier before dispatching any admitted prefix.
    if (admissionError) throw new Error(admissionError);
  }

  function beginRequest(method, args, { queue = false } = {}) {
    assertQueueCapacity(queue);
    const methodName = String(method);
    const sequence = (bridgeSequences.get(methodName) ?? 0) + 1;
    bridgeSequences.set(methodName, sequence);
    const id = "bridge:" + methodName + ":" + String(sequence);
    const argsJson = JSON.stringify(safe(args ?? []));
    // Guest toJSON/getters can create requests while serializing this input.
    assertQueueCapacity(queue);
    const callStack = new GuestError().stack;
    let callbacks;
    const promise = new Promise((resolve, reject) => { callbacks = { resolve, reject }; });
    const admit = () => {
      callbacks.stack = callStack;
      callbacks.location = hostRequest(methodName, argsJson, id, callStack);
      pending.set(id, callbacks);
    };
    if (queue || pending.size >= maxPending) {
      queued.set(id, { admit, callbacks, ordinary: !queue });
      if (!queue) queuedOrdinaryCount++;
    } else admit();
    return { id, promise };
  }

  // Admission and cancellation release capacity through the same owner.
  function takeQueuedRequest(id) {
    const entry = queued.get(id);
    if (!entry) return;
    queued.delete(id);
    if (entry.ordinary) queuedOrdinaryCount--;
    return entry;
  }

  // Refill after guest continuations run so dependent ordinary calls retain
  // first use of released slots. Waiting requests refill in insertion order.
  // Closures, copied inputs, and stable IDs live only in the bounded VM snapshot.
  function drainQueuedRequests() {
    while (queued.size > 0 && pending.size < maxPending) {
      const id = queued.keys().next().value;
      takeQueuedRequest(id).admit();
    }
  }

  function request(method, args, options) {
    return beginRequest(method, args, options).promise;
  }

  function scheduleTimer(callback, delay, args) {
    if (typeof callback !== "function") {
      throw new TypeError("setTimeout callback must be a function");
    }
    const numericDelay = Number(delay);
    const delayMs = Number.isFinite(numericDelay) ? Math.max(0, Math.floor(numericDelay)) : 0;
    const timerId = ++nextTimerId;
    const timerRequest = beginRequest("sleep", [delayMs]);
    timers.set(timerId, timerRequest.id);
    void timerRequest.promise.then(() => {
      if (!timers.delete(timerId)) return;
      callback(...args);
    });
    return timerId;
  }

  function cancelTimer(timerId) {
    const requestId = timers.get(Number(timerId));
    if (!requestId) return;
    timers.delete(Number(timerId));
    const queuedEntry = takeQueuedRequest(requestId);
    if (queuedEntry) {
      queuedEntry.callbacks.resolve(null);
      return;
    }
    hostCancelRequest(requestId);
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.resolve(null);
  }

  ${CODE_MODE_SWARM_CONTROLLER_SOURCE}

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
      const error = new GuestError(typeof parsed === "string" ? parsed : parsed?.message ?? "nested tool failed");
      if (entry.stack) Object.defineProperty(error, "stack", { value: entry.stack, writable: true, configurable: true });
      if (entry.location) error.location = entry.location;
      if (parsed && typeof parsed === "object") {
        error.code = parsed.code;
        error.effectStatus = "unknown";
      }
      entry.reject(error);
    }
    return true;
  }

  function nodeHandle(descriptor) {
    const handle = Object.create(null);
    Object.defineProperties(handle, {
      id: { value: descriptor.id, enumerable: true },
      name: { value: descriptor.name, enumerable: true },
      invoke: {
        value: (command, params) => request("nodes", ["invoke", descriptor.id, command, params]),
        enumerable: true,
      },
    });
    if (typeof descriptor.listDirCommand === "string") {
      Object.defineProperty(handle, "listDir", {
        value: (path) => request("nodes", ["invoke", descriptor.id, descriptor.listDirCommand, { path }]),
        enumerable: true,
      });
    }
    return Object.freeze(handle);
  }

  const nodes = Object.freeze({
    list: () => request("nodes", ["list"]),
    get: async (idOrName) => nodeHandle(await request("nodes", ["get", idOrName])),
  });

  const skills = Object.freeze({
    list: () => request("skillsList", []),
    read: (name) => request("skillsRead", [name]),
  });

  if (globalThis.__openclawSwarmEnabled === true) {
    Object.defineProperties(globalThis, {
      agents: {
        value: Object.freeze({ run: runAgent }),
        enumerable: true,
      },
      phase: { value: (title) => swarmNote("phase", title), enumerable: true },
      log: { value: (message) => swarmNote("log", message), enumerable: true },
    });
  }

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
  // Native declarations are generated by describe only when read, not injected
  // for every tool into every VM. Listing needs only the bounded callable metadata.
  const nativeApiFiles = new Map(catalogBindings.map(binding => [
    "tools/" + binding.callableName + ".d.ts", binding.callableName,
  ]));
  const api = Object.freeze({
    list: async (prefix = "") => {
      // list takes a directory prefix, so tolerate a trailing slash (API.list("mcp/"))
      // that read's exact-path normalizer would otherwise reject as an empty segment.
      const rawPrefix = prefix == null ? "" : String(prefix).trim().replace(/\/+$/, "");
      const normalizedPrefix = rawPrefix === "" ? "" : normalizeApiPath(rawPrefix);
      const files = [...apiFileMap.values(), ...[...nativeApiFiles.keys()].map(path => ({ path }))]
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
      if (file) return file;
      const callableName = nativeApiFiles.get(normalizedPath);
      if (callableName) return request("describe", [callableName, "declaration"]);
      throw new Error("Unknown API file: " + normalizedPath);
    },
  });

  const callableHandles = new Map();
  const callableMetadata = new WeakMap();
  function callableHandle(binding) {
    const callableName = typeof binding?.callableName === "string" ? binding.callableName : "";
    if (!callableName) return null;
    const existing = callableHandles.get(callableName);
    if (existing) return existing;
    const handle = (input) => request("callValue", [callableName, input]);
    const metadata = Object.freeze({
      callableName,
      toolName: typeof binding.name === "string" ? binding.name : callableName,
      label: typeof binding.label === "string" ? binding.label : undefined,
      description: typeof binding.description === "string" ? binding.description : "",
      source: binding.source,
      input: binding.input,
      output: binding.output,
    });
    for (const [key, value] of Object.entries(metadata)) {
      Object.defineProperty(handle, key, { value, enumerable: true });
    }
    Object.defineProperties(handle, {
      name: { value: callableName },
      describe: { value: () => request("describe", [callableName]), enumerable: true },
      toJSON: { value: () => metadata },
    });
    const frozen = Object.freeze(handle);
    callableHandles.set(callableName, frozen);
    callableMetadata.set(frozen, metadata);
    return frozen;
  }
  // Final values may nest handles (Promise.all of searches, keyed maps); an
  // unserialized handle dumps as null and the model never learns the tool name.
  function serializeOutputValue(value, seen = new Map()) {
    if (value instanceof GuestPromise) return promiseOutput;
    const metadata = callableMetadata.get(value);
    if (metadata) return metadata;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    const proto = Object.getPrototypeOf(value);
    const isError = value instanceof Error;
    if (!isError && !Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
    const plain = Array.isArray(value) ? new Array(value.length) : isError ? { name: value.name, message: value.message } : {};
    // Project before JSON.stringify can invoke Error.toJSON, and preserve graph
    // identity so cyclic custom fields use the ordinary bounded JSON fallback.
    seen.set(value, plain);
    for (const key of Object.keys(value)) {
      if (isError && key === "toJSON") continue;
      Object.defineProperty(plain, key, {
        value: serializeOutputValue(value[key], seen), enumerable: true, configurable: true, writable: true,
      });
    }
    return plain;
  }
  const catalog = Object.freeze({
    search: async (query, options) => {
      const matches = await request("search", [query, options]);
      return Object.freeze(matches.map((name) =>
        callableHandles.get(String(name))
      ).filter(Boolean));
    },
    all: () => Object.freeze([...callableHandles.values()]),
  });

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

  for (const binding of catalogBindings) {
    const handle = callableHandle(binding);
    const callableName = typeof binding?.callableName === "string" ? binding.callableName : "";
    if (!handle || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callableName)) continue;
    Object.defineProperty(globalThis, callableName, {
      value: handle,
      enumerable: true,
      configurable: true,
    });
  }

  Object.defineProperties(globalThis, {
    API: { value: api, enumerable: true },
    catalog: { value: catalog, enumerable: true },
    nodes: { value: nodes, enumerable: true },
    namespaces: { value: Object.freeze(namespaceGlobals), enumerable: true },
    skills: { value: skills, enumerable: true },
    setTimeout: { value: (callback, delay, ...args) => scheduleTimer(callback, delay, args), enumerable: true },
    clearTimeout: { value: cancelTimer, enumerable: true },
    console: { value: guestConsole, enumerable: true },
    text: { value: (value) => output.push({ type: "text", text: asText(value) }), enumerable: true },
    json: { value: (value) => output.push({ type: "json", value: safe(value, true) }), enumerable: true },
    yield_control: { value: (reason) => request("yield", [reason]), enumerable: true },
    __openclawSettleBridge: { value: settle },
    __openclawDrainQueuedRequests: { value: drainQueuedRequests },
    __openclawAdmissionError: { value: () => admissionError },
    __openclawSerializeCatalogHandles: { value: serializeOutputValue },
    __openclawTakeOutput: { value: () => output.splice(0) },
    __openclawTrackRejection: {
      value: (promise, reason, handled) => {
        if (handled) unhandledRejections.delete(promise);
        else unhandledRejections.set(promise, reason);
      },
    },
    __openclawUnhandledRejection: { value: () => unhandledRejections.keys().next().value },
  });
})();
`;
