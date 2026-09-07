import type { AgentMessage } from "../runtime/index.js";

const STEERING_MESSAGE_IDENTITY = Symbol.for("openclaw.steeringMessageIdentity");
const steeringMessagePersistenceFailureListeners = new Map<string, Set<(error: unknown) => void>>();

export function setSteeringMessageIdentity(
  message: AgentMessage,
  identity: string | undefined,
): void {
  if (identity) {
    Object.defineProperty(message, STEERING_MESSAGE_IDENTITY, {
      configurable: true,
      value: identity,
    });
  }
}

export function getSteeringMessageIdentity(message: unknown): string | undefined {
  return message && typeof message === "object"
    ? ((message as Record<PropertyKey, unknown>)[STEERING_MESSAGE_IDENTITY] as string | undefined)
    : undefined;
}

/** Keeps persistence failures private to the exact in-flight steering identity. */
export function subscribeSteeringMessagePersistenceFailure(
  identity: string,
  listener: (error: unknown) => void,
): () => void {
  const listeners = steeringMessagePersistenceFailureListeners.get(identity) ?? new Set();
  listeners.add(listener);
  steeringMessagePersistenceFailureListeners.set(identity, listeners);
  return () => {
    listeners.delete(listener);
    if (
      listeners.size === 0 &&
      steeringMessagePersistenceFailureListeners.get(identity) === listeners
    ) {
      steeringMessagePersistenceFailureListeners.delete(identity);
    }
  };
}

/** Rejects a queued receipt before a failed append can strand or acknowledge its source. */
export function reportSteeringMessagePersistenceFailure(message: unknown, error: unknown): void {
  const identity = getSteeringMessageIdentity(message);
  if (identity) {
    steeringMessagePersistenceFailureListeners
      .get(identity)
      ?.forEach((listener) => listener(error));
  }
}
