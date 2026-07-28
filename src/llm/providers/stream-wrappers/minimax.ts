import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { streamSimple } from "../../stream.js";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);
type DynamicFastMode = boolean | (() => boolean | undefined);

function resolveMinimaxFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}

function isMinimaxAnthropicMessagesModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
  );
}

/**
 * MiniMax-M3 (and any forward-compatible MiniMax-M3.x successor) emits proper
 * Anthropic-shape thinking blocks (`content_block_start` with `type:"thinking"`
 * + `thinking_delta`) and **requires** thinking to be active to produce any
 * visible text. Pinning `thinking: { type: "disabled" }` on M3 makes the model
 * return an empty content array with `stop_reason: "end_turn"` and 1 output
 * token, observed against `https://api.minimax.io/anthropic/v1/messages`.
 *
 * The legacy MiniMax-M2.x family still needs the disable-thinking shim
 * because their Anthropic-compat streams leak `reasoning_content` in
 * OpenAI-style deltas (see {@link createMinimaxThinkingDisabledWrapper}).
 */
function isMinimaxModelRequiringThinking(model: { id?: unknown }): boolean {
  const modelId = typeof model.id === "string" ? model.id.trim() : "";
  return /^MiniMax-M3(\b|[-.])/i.test(modelId);
}

function isDisabledThinkingPayload(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "disabled"
  );
}

function isEnabledThinkingPayload(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "enabled"
  );
}

function resolvePositiveMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** @deprecated MiniMax provider-owned stream helper; do not use from third-party plugins. */
export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: DynamicFastMode,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      (typeof fastMode === "function" ? fastMode() : fastMode) !== true ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveMinimaxFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

/**
 * Legacy MiniMax (M2.x) Anthropic-compatible streaming endpoint returns
 * reasoning_content in OpenAI-style delta chunks ({delta: {content: "",
 * reasoning_content: "..."}}) rather than the native Anthropic thinking
 * block format. The shared Anthropic provider cannot process this format
 * and leaks the reasoning text as visible content. Disable thinking in the
 * outgoing payload so MiniMax does not produce reasoning_content deltas
 * during streaming.
 *
 * Skipped for MiniMax-M3 and M3.x, which emit proper Anthropic-shape thinking
 * blocks and require thinking enabled to produce any visible content.
 * The Anthropic transport builds `thinking: { type: "disabled" }` when no
 * resolved thinking level exists, so M3 removes that implicit disabled payload.
 * See {@link isMinimaxModelRequiringThinking}.
 */
export function createMinimaxThinkingDisabledWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }
    const requiresThinking = isMinimaxModelRequiringThinking(model);

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (requiresThinking) {
            if (thinkingLevel === undefined && isDisabledThinkingPayload(payloadObj.thinking)) {
              delete payloadObj.thinking;
            } else if (
              thinkingLevel !== "off" &&
              (isEnabledThinkingPayload(payloadObj.thinking) ||
                isDisabledThinkingPayload(payloadObj.thinking))
            ) {
              payloadObj.thinking = { type: "adaptive" };
              const maxTokens = resolvePositiveMaxTokens(options?.maxTokens);
              if (maxTokens !== undefined) {
                payloadObj.max_tokens = maxTokens;
              }
            }
          }
          // M2.x only needs the shim when no earlier wrapper set thinking.
          // Downstream payload hooks still run after this wrapper.
          if (!requiresThinking && payloadObj.thinking === undefined) {
            payloadObj.thinking = { type: "disabled" };
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
