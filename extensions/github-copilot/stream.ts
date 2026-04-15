import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";

type _StreamContext = Parameters<StreamFn>[1];

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

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return wrapCopilotAnthropicStream(ctx.streamFn);
}
