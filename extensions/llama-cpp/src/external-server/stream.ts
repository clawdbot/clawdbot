import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_SERVER_PROVIDER_ID } from "./defaults.js";

/** Disables chat-template reasoning when OpenClaw selected thinking off. */
function normalizeLlamaServerThinking(
  payload: unknown,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): unknown {
  if (!isRecord(payload) || thinkingLevel !== "off") {
    return payload;
  }
  const existing = isRecord(payload.chat_template_kwargs) ? payload.chat_template_kwargs : {};
  return {
    ...payload,
    chat_template_kwargs: {
      ...existing,
      enable_thinking: false,
    },
  };
}

/** Keeps the shared OpenAI transport and adjusts only llama-server template behavior. */
export function wrapLlamaServerStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== LLAMA_SERVER_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        const customized = (await onPayload?.(payload, requestModel)) ?? payload;
        return normalizeLlamaServerThinking(customized, ctx.thinkingLevel);
      },
    });
  };
}
