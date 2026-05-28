import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AgentMessage } from "../../runtime/index.js";

export type MessageTransform = (messages: AgentMessage[], model: unknown) => AgentMessage[];

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
      model,
      {
        ...(context as unknown as Record<string, unknown>),
        messages: nextMessages,
      } as typeof context,
      options,
    );
  };
}
