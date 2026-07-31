import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { LLAMA_SERVER_PROVIDER_ID } from "./defaults.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Maps the requested response format to the shape llama-server accepts. */
export function normalizeLlamaServerPayload(
  payload: unknown,
  requestedResponseFormat?: Record<string, unknown>,
): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  const responseFormat = isRecord(payload.response_format)
    ? payload.response_format
    : requestedResponseFormat;
  if (!responseFormat) {
    return payload;
  }
  if (responseFormat.type === "text") {
    return { ...payload, response_format: responseFormat };
  }
  const schema =
    responseFormat.type === "json_schema"
      ? isRecord(responseFormat.json_schema)
        ? responseFormat.json_schema.schema
        : responseFormat.schema
      : responseFormat.type === "json_object"
        ? responseFormat.schema
        : responseFormat;
  if (!isRecord(schema)) {
    return payload;
  }
  return {
    ...payload,
    response_format: {
      type: "json_object",
      schema,
    },
  };
}

/** Keeps the shared OpenAI transport and adjusts only llama-server payload quirks. */
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
        return normalizeLlamaServerPayload(customized, options?.responseFormat);
      },
    });
  };
}
