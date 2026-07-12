/**
 * Stream wrapper for Cloudflare AI Gateway's Anthropic Messages compatibility
 * quirks.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createAnthropicThinkingPrefillPayloadWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("cloudflare-ai-gateway-stream");

function shouldPatchAnthropicMessagesPayload(model: ProviderWrapStreamFnContext["model"]): boolean {
  return model?.api === undefined || model.api === "anthropic-messages";
}

/**
 * Creates a wrapper that removes trailing assistant prefill messages before
 * extended-thinking Anthropic requests are sent through Cloudflare.
 */
export function createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn, (stripped) => {
    log.warn(
      `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because Anthropic extended thinking requires conversations to end with a user turn`,
    );
  });
}

/**
 * Applies the Anthropic payload wrapper only for Anthropic-compatible models.
 */
export function wrapCloudflareAiGatewayProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (!shouldPatchAnthropicMessagesPayload(ctx.model)) {
    return ctx.streamFn;
  }
  return createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(ctx.streamFn);
}

/** Test-only access to wrapper decisions and logger injection points. */
export const testing = { log, shouldPatchAnthropicMessagesPayload };
