/** Sandboxed guest globals and host bridge for Code Mode QuickJS cells. */
import { CODE_MODE_SWARM_CONTROLLER_SOURCE } from "./code-mode-swarm-controller-source.js";

export const CODE_MODE_CONTROLLER_SOURCE = String.raw`
(() => {
  const output = [];
  const pending = new Map();
  const queued = [];
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
  const promiseOutput = "[Unawaited Promise: use await or Promise.all(...) before emitting or returning values.]";

  function outputReplacer(_key, value) {
    return value instanceof GuestPromise ? promiseOutput : value;
  }

  function safe(value, diagnosePromises = false) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value, diagnosePromises ? outputReplacer : undefined));
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

  function beginRequest(method, args, { queue = false } = {}) {
    const methodName = String(method);
    const sequence = (bridgeSequences.get(methodName) ?? 0) + 1;
    bridgeSequences.set(methodName, sequence);
    const id = "bridge:" + methodName + ":" + String(sequence);
    const argsJson = JSON.stringify(safe(args ?? []));
    let callbacks;
    const promise = new Promise((resolve, reject) => { callbacks = { resolve, reject }; });
    const admit = () => {
      hostRequest(methodName, argsJson, id);
      pending.set(id, callbacks);
    };
    if (queue) queued.push(admit);
    else admit();
    return { id, promise };
  }

  // Refill after guest continuations run so collector results can trigger ordinary
  // tools before queued Swarm work takes their released slots.
  // Closures and stable IDs live in the bounded VM snapshot, never a second host queue.
  function drainQueuedRequests() {
    while (queued.length > 0 && pending.size < maxPending) queued.shift()();
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
      const error = new Error(typeof parsed === "string" ? parsed : parsed?.message ?? "nested tool failed");
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
  const api = Object.freeze({
    list: async (prefix = "") => {
      // list takes a directory prefix, so tolerate a trailing slash (API.list("mcp/"))
      // that read's exact-path normalizer would otherwise reject as an empty segment.
      const rawPrefix = prefix == null ? "" : String(prefix).trim().replace(/\/+$/, "");
      const normalizedPrefix = rawPrefix === "" ? "" : normalizeApiPath(rawPrefix);
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
  function serializeCatalogHandles(value, seen = new Set()) {
    if (value instanceof GuestPromise) return promiseOutput;
    const metadata = callableMetadata.get(value);
    if (metadata) return metadata;
    if (value === null || typeof value !== "object" || seen.has(value)) return value;
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => serializeCatalogHandles(entry, seen));
      const plain = {};
      for (const [key, entry] of Object.entries(value)) {
        plain[key] = serializeCatalogHandles(entry, seen);
      }
      return plain;
    } finally {
      seen.delete(value);
    }
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
    text: { value: (value) => output.push({ type: "text", text: asText(value) }), enumerable: true },
    json: { value: (value) => output.push({ type: "json", value: safe(value, true) }), enumerable: true },
    yield_control: { value: (reason) => request("yield", [reason]), enumerable: true },
    __openclawSettleBridge: { value: settle },
    __openclawDrainQueuedRequests: { value: drainQueuedRequests },
    __openclawSerializeCatalogHandles: { value: serializeCatalogHandles },
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
