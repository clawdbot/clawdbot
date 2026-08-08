import type { AgentMessage } from "../runtime/index.js";

const STEERING_MESSAGE_IDENTITY = Symbol.for("openclaw.steeringMessageIdentity");

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
