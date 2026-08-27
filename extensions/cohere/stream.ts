import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

export function wrapCohereProviderStream(ctx: ProviderWrapStreamFnContext) {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
    // Cohere's Compatibility API uses developer, not system, for instructions.
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((message) =>
        message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).role === "system"
          ? { ...(message as Record<string, unknown>), role: "developer" }
          : message,
      );
    }

    // Cohere lets tool-capable models choose a tool when tool_choice is omitted.
    delete payload.tool_choice;
  });
}
