/**
 * Wraps stream functions with pre-call message transforms.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AgentMessage } from "../../runtime/index.js";

/**
 * Stream wrapper for applying message transforms immediately before provider dispatch.
 */
export type MessageTransform = (messages: AgentMessage[], model: unknown) => AgentMessage[];

/** Wraps a stream function with a conditional message-list transform. */
export function wrapStreamFnWithMessageTransform(
  streamFn: StreamFn,
  transform: MessageTransform,
): StreamFn {
  return (model, context, options) => {
    const messages = (context as unknown as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      return streamFn(model, context, options);
    }

    const nextMessages = transform(messages as AgentMessage[], model);
    if (nextMessages === messages) {
      return streamFn(model, context, options);
    }

    return streamFn(
      // Clone the context instead of mutating it so callers can reuse the original assembled
      // context for logging, replay, or retry comparisons.
      model,
      {
        ...(context as unknown as Record<string, unknown>),
        messages: nextMessages,
      } as typeof context,
      options,
    );
  };
}
