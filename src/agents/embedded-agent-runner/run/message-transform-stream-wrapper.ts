import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
/**
 * Wraps stream functions with pre-call message transforms.
 */
import {
  PROVIDER_CONTEXT_HANDOFF,
  type ProviderContext,
  type ProviderStreamOptions,
} from "../../../../packages/ai/src/provider-types.js";
import type { AgentMessage } from "../../runtime/index.js";

/**
 * Stream wrapper for applying message transforms immediately before provider dispatch.
 */
type MessageTransform = (messages: AgentMessage[], model: unknown) => AgentMessage[];
type ProviderContextMaterializer = (input: {
  context: Parameters<StreamFn>[1];
  signal?: AbortSignal;
}) => Promise<ProviderContext>;

/** Wraps a stream function with a conditional message-list transform. */
export function wrapStreamFnWithMessageTransform(
  streamFn: StreamFn,
  transform: MessageTransform,
  materializeProviderContext?: ProviderContextMaterializer,
): StreamFn {
  return (model, context, options) => {
    const messages = context?.messages;
    const nextMessages = Array.isArray(messages)
      ? transform(messages as AgentMessage[], model)
      : messages;
    const nextContext =
      Array.isArray(messages) && nextMessages !== messages
        ? {
            ...context,
            messages: nextMessages as typeof context.messages,
          }
        : context;
    if (!materializeProviderContext) {
      return streamFn(model, nextContext, options);
    }
    let availableContext: Parameters<StreamFn>[1] | undefined = nextContext;
    const handoff = async (): Promise<ProviderContext> => {
      const captured = availableContext;
      availableContext = undefined;
      if (!captured) {
        throw new Error("provider context handoff already consumed");
      }
      options?.signal?.throwIfAborted();
      return await materializeProviderContext({
        context: captured,
        signal: options?.signal,
      });
    };
    return streamFn(model, nextContext, {
      ...options,
      [PROVIDER_CONTEXT_HANDOFF]: handoff,
    } as ProviderStreamOptions & NonNullable<Parameters<StreamFn>[2]>);
  };
}
