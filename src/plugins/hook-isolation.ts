import type { PluginHookName } from "./types.js";

export class HookIsolationError extends Error {}

type WebAssemblyMemoryConstructor = {
  new (...args: unknown[]): object;
  prototype: object;
};

function containsSharedMemory(value: unknown, seen: Set<object>): boolean {
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (ArrayBuffer.isView(value)) {
    return typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer;
  }
  if (value instanceof ArrayBuffer) {
    return false;
  }
  const webAssemblyMemory = (
    globalThis as unknown as {
      WebAssembly?: { Memory?: WebAssemblyMemoryConstructor };
    }
  ).WebAssembly?.Memory;
  if (
    webAssemblyMemory &&
    value instanceof webAssemblyMemory &&
    typeof SharedArrayBuffer !== "undefined"
  ) {
    if (Reflect.get(webAssemblyMemory.prototype, "buffer", value) instanceof SharedArrayBuffer) {
      return true;
    }
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof Map) {
    const entries = Map.prototype.entries.call(value) as IterableIterator<[unknown, unknown]>;
    for (const [key, entry] of entries) {
      if (containsSharedMemory(key, seen) || containsSharedMemory(entry, seen)) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    const entries = Set.prototype.values.call(value) as IterableIterator<unknown>;
    for (const entry of entries) {
      if (containsSharedMemory(entry, seen)) {
        return true;
      }
    }
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor && containsSharedMemory(descriptor.value, seen)) {
      return true;
    }
  }
  return false;
}

export function cloneHookIsolationValue<T>(hookName: PluginHookName, value: T): T {
  try {
    if (containsSharedMemory(value, new Set<object>())) {
      throw new TypeError("shared memory cannot be isolated");
    }
    const cloned = structuredClone(value);
    if (containsSharedMemory(cloned, new Set<object>())) {
      throw new TypeError("shared memory cannot be isolated");
    }
    return cloned;
  } catch (cause) {
    throw new HookIsolationError(`[hooks] ${hookName} mutable input isolation failed`, { cause });
  }
}
