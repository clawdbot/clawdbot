import type { AgentMessage } from "../runtime/index.js";

const queuedUserMessageRetirements = new WeakMap<AgentMessage, () => boolean>();

/** Binds one runtime message to the exact display entry created for it. */
export function registerQueuedUserMessageRetirement(
  message: AgentMessage,
  retire: () => boolean,
): void {
  queuedUserMessageRetirements.set(message, retire);
}

/** Consumes the display retirement owned by this exact runtime message. */
export function retireQueuedUserMessage(message: AgentMessage): boolean {
  const retire = queuedUserMessageRetirements.get(message);
  if (!retire) {
    return false;
  }
  queuedUserMessageRetirements.delete(message);
  return retire();
}
