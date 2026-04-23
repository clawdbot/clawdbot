import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { rewriteCopilotResponsePayloadConnectionBoundIds } from "./connection-bound-ids.js";

type _StreamContext = Parameters<StreamFn>[1];
type StreamOptions = Parameters<StreamFn>[2];

function patchOnPayloadResult(result: unknown): unknown {
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((next) => {
      rewriteCopilotResponsePayloadConnectionBoundIds(next);
      return next;
    });
  }
  rewriteCopilotResponsePayloadConnectionBoundIds(result);
  return result;
}

export function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: {
          ...buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages: hasCopilotVisionInput(context.messages),
          }),
          ...options?.headers,
        },
      },
      applyAnthropicEphemeralCacheControlMarkers,
    );
  };
}

export function wrapCopilotOpenAIResponsesStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    const wrappedOptions: StreamOptions = {
      ...options,
      onPayload: (payload, payloadModel) => {
        rewriteCopilotResponsePayloadConnectionBoundIds(payload);
        return patchOnPayloadResult(originalOnPayload?.(payload, payloadModel));
      },
    };
    return underlying(model, context, wrappedOptions);
  };
}

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return wrapCopilotOpenAIResponsesStream(wrapCopilotAnthropicStream(ctx.streamFn));
}
