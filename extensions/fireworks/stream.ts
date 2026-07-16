import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { isFireworksKimiModelId } from "./model-id.js";

function isFireworksProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "fireworks" || normalized === "fireworks-ai";
}

export function createFireworksKimiThinkingDisabledWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      // Fireworks Kimi can emit chain-of-thought in visible `content` unless
      // the Anthropic-style thinking toggle is explicitly disabled.
      payloadObj.thinking = { type: "disabled" };
      delete payloadObj.reasoning;
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
    });
}

export function wrapFireworksProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (
    !isFireworksProviderId(ctx.provider) ||
    ctx.model?.api !== "openai-completions" ||
    !isFireworksKimiModelId(ctx.modelId)
  ) {
    return undefined;
  }
  return createFireworksKimiThinkingDisabledWrapper(ctx.streamFn);
}
