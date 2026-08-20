import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { setQwenChatTemplateThinking } from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";

/** Maps shared structured-output requests to the shape accepted by older llama-server builds. */
function normalizeLlamaServerResponseFormat(
  payload: Record<string, unknown>,
  requestedResponseFormat?: Record<string, unknown>,
): void {
  const responseFormat = isRecord(payload.response_format)
    ? payload.response_format
    : requestedResponseFormat;
  if (!responseFormat || responseFormat.type === "text") {
    return;
  }
  const schema =
    responseFormat.type === "json_schema"
      ? isRecord(responseFormat.json_schema)
        ? responseFormat.json_schema.schema
        : responseFormat.schema
      : responseFormat.type === "json_object"
        ? responseFormat.schema
        : responseFormat;
  if (isRecord(schema)) {
    payload.response_format = { type: "json_object", schema };
  }
}

/** Keeps the shared OpenAI transport and adjusts llama-server request compatibility. */
export function wrapLlamaServerStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== LLAMA_CPP_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        const customized = (await onPayload?.(payload, requestModel)) ?? payload;
        if (isRecord(customized)) {
          if (ctx.thinkingLevel === "off") {
            setQwenChatTemplateThinking(customized, false);
          }
          normalizeLlamaServerResponseFormat(customized, options?.responseFormat);
        }
        return customized;
      },
    });
  };
}
