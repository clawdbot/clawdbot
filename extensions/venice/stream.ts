import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

function isVeniceDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

function ensureVeniceDeepSeekV4Replay(payload: Record<string, unknown>): void {
  delete payload.thinking;
  delete payload.reasoning;
  delete payload.reasoning_effort;

  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "assistant" && Array.isArray(record.tool_calls)) {
      record.reasoning_content ??= "";
    }
  }
}

export function createVeniceDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  void thinkingLevel;
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    if (model.provider === "venice" && isVeniceDeepSeekV4ModelId(model.id)) {
      ensureVeniceDeepSeekV4Replay(payload);
    }
  });
}
