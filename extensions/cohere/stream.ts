import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

function patchCoherePayload(payload: Record<string, unknown>): void {
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
}

export function createCohereCompletionsWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) =>
    patchCoherePayload(payload),
  );
}
