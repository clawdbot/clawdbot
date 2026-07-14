/**
 * MiniMax fast-mode stream wrapper. `/fast` opts M2.7 into the highspeed model
 * and M3 into MiniMax's paid priority tier, recording each lane's real cost.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeFastMode } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMinimaxApiCost } from "./model-definitions.js";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);
// MiniMax bills the M3 priority tier at 1.5x the standard M3 rate. The lane is
// selected per request, so the multiplier belongs here rather than in the
// catalog cost that unaccelerated requests keep using.
const MINIMAX_PRIORITY_COST_MULTIPLIER = 1.5;

function isMinimaxM3(modelId: string): boolean {
  return /^MiniMax-M3(\b|[-.])/i.test(modelId);
}

/** Resolve MiniMax fast-mode setting from model extra params. */
function resolveMinimaxFastMode(extraParams: Record<string, unknown> | undefined): boolean {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const fastMode =
    typeof raw === "function"
      ? normalizeFastMode((raw as () => unknown)() as string | boolean | null | undefined)
      : normalizeFastMode(raw as string | boolean | null | undefined);
  return fastMode === true;
}

function applyMinimaxPriorityPricing(model: Parameters<StreamFn>[0]): Parameters<StreamFn>[0] {
  return {
    ...model,
    cost: {
      input: model.cost.input * MINIMAX_PRIORITY_COST_MULTIPLIER,
      output: model.cost.output * MINIMAX_PRIORITY_COST_MULTIPLIER,
      cacheRead: model.cost.cacheRead * MINIMAX_PRIORITY_COST_MULTIPLIER,
      cacheWrite: model.cost.cacheWrite * MINIMAX_PRIORITY_COST_MULTIPLIER,
    },
  };
}

/** Provider `wrapStreamFn`: routes MiniMax `/fast` requests to the faster paid lane and records its cost. */
export function wrapMinimaxFastModeStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      !resolveMinimaxFastMode(ctx.extraParams) ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }
    const modelId = model.id.trim();
    const highspeedId = MINIMAX_FAST_MODEL_IDS.get(modelId);
    if (highspeedId) {
      // Highspeed is its own catalog model: swap id and cost together so the
      // recorded rate cannot drift from the model actually billed.
      return underlying(
        { ...model, id: highspeedId, cost: resolveMinimaxApiCost(highspeedId) },
        context,
        options,
      );
    }
    if (!isMinimaxM3(modelId)) {
      return underlying(model, context, options);
    }
    // M3 has no highspeed model, so the priority service_tier is its fast lane.
    // An explicit upstream service_tier wins; this wrapper only fills the gap.
    const priorityModel = applyMinimaxPriorityPricing(model);
    const originalOnPayload = options?.onPayload;
    return underlying(priorityModel, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (payloadObj.service_tier === undefined) {
            payloadObj.service_tier = "priority";
          }
        }
        // Downstream hooks must see the model this request is billed against,
        // not the pre-priority catalog entry.
        return originalOnPayload?.(payload, priorityModel);
      },
    });
  };
}
