/**
 * Wraps stream functions with pre-call message transforms.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AgentMessage } from "../../runtime/index.js";

/**
 * Stream wrapper for applying message transforms immediately before provider dispatch.
 */
type MessageTransform = (messages: AgentMessage[], model: unknown) => AgentMessage[];
type StreamContext = Parameters<StreamFn>[1];
type ContextTransform = (context: StreamContext, model: unknown) => StreamContext;

/** Wraps a stream function with a complete provider-context transform. */
export function wrapStreamFnWithContextTransform(
  streamFn: StreamFn,
  transform: ContextTransform,
): StreamFn {
  return (model, context, options) => {
    // Some AgentSession adapters use a context-free stream invocation to advance their own
    // prompt lifecycle. That is not a provider dispatch, so preserve it without transforming.
    if (!context || typeof context !== "object") {
      return streamFn(model, context, options);
    }
    return streamFn(model, transform(context, model), options);
  };
}

/** Wraps a stream function with a conditional message-list transform. */
export function wrapStreamFnWithMessageTransform(
  streamFn: StreamFn,
  transform: MessageTransform,
): StreamFn {
  return wrapStreamFnWithContextTransform(streamFn, (context, model) => {
    const messages = (context as unknown as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      return context;
    }

    const nextMessages = transform(messages as AgentMessage[], model);
    if (nextMessages === messages) {
      return context;
    }

    // Clone the context instead of mutating it so callers can reuse the original assembled
    // context for logging, replay, or retry comparisons.
    return {
      ...(context as unknown as Record<string, unknown>),
      messages: nextMessages,
    } as typeof context;
  });
}
