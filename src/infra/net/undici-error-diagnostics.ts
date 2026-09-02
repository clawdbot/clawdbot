import { EventEmitter } from "node:events";
import { logDebug } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";

const observedDispatcherValues = new WeakSet<object>();

function logUndiciDispatcherError(error: unknown): void {
  logDebug(`undici: internal dispatcher error: ${formatErrorMessage(error)}`);
}

function observeDispatcherValue(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return;
  }
  if (observedDispatcherValues.has(value)) {
    return;
  }
  observedDispatcherValues.add(value);

  if (value instanceof EventEmitter) {
    // Undici nests clients behind agents and proxy dispatchers. Observe both
    // existing children and future connect targets without replacing factories.
    EventEmitter.prototype.on.call(value, "error", logUndiciDispatcherError);
    EventEmitter.prototype.on.call(value, "connect", (_origin: unknown, targets: unknown) => {
      observeDispatcherValue(targets);
    });
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) {
        observeDispatcherValue(descriptor.value);
      }
    }
    return;
  }

  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) {
      observeDispatcherValue(entry);
    }
    return;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) {
      observeDispatcherValue(entry);
    }
  }
}

export function withUndiciErrorDiagnostics<T extends import("undici").Dispatcher>(
  dispatcher: T,
): T {
  observeDispatcherValue(dispatcher);
  return dispatcher;
}
