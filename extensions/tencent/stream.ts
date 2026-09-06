import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  type OpenAICompatibleThinkingLevel,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { TOKENHUB_PROVIDER_ID, TOKENPLAN_PROVIDER_ID } from "./models.js";

const TENCENT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_PROVIDER_ID,
]);

type StreamModel = Parameters<StreamFn>[0];
type StreamOptions = Parameters<StreamFn>[2];

// hy3 (GA) is the only Tencent model with a verified two-rung effort ladder:
// the gateway accepts `none` and `high` exclusively, so intermediate rungs must
// collapse upward before dispatch.
//
// Scope this map to hy3 ONLY. Do not add new model ids here on the assumption
// that they behave the same — an unverified collapse silently upgrades a `low`
// request to `high` (extra thinking tokens and latency, no diagnostic). If a
// future model turns out to need its own rewrite, give it its own map keyed on
// that model id.
const TENCENT_TWO_RUNG_EFFORT_MAP: Readonly<Record<string, string>> = Object.freeze({
  off: "none",
  none: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
});

// Keyed on the model id rather than the provider: hy3 behaves identically on
// TokenHub and TokenPlan.
const TENCENT_TWO_RUNG_MODEL_IDS: ReadonlySet<string> = new Set(["hy3"]);

function resolveRequestedEffort(
  thinkingLevel: OpenAICompatibleThinkingLevel,
  options: StreamOptions,
): string | undefined {
  const withEffort = (options ?? {}) as { reasoningEffort?: unknown; reasoning?: unknown };
  const raw =
    (typeof withEffort.reasoningEffort === "string" && withEffort.reasoningEffort) ||
    (typeof withEffort.reasoning === "string" && withEffort.reasoning) ||
    (typeof thinkingLevel === "string" && thinkingLevel) ||
    undefined;
  return raw ? raw.trim().toLowerCase() : undefined;
}

function mapEffortForTencent(model: StreamModel, effort: string | undefined): string | undefined {
  if (!effort) {
    return undefined;
  }
  const modelId = (model as { id?: unknown }).id;
  if (typeof modelId === "string" && TENCENT_TWO_RUNG_MODEL_IDS.has(modelId)) {
    return TENCENT_TWO_RUNG_EFFORT_MAP[effort];
  }
  // Every other Tencent model (hy3-preview, hy4-preview, …) is left untouched:
  // returning undefined makes the wrapper skip the payload patch entirely, so
  // the shared OpenClaw effort handling — which already normalized the payload
  // against the model's declared supportedReasoningEfforts — stays in control.
  return undefined;
}

function isTencentCompletionsCall(model: StreamModel): boolean {
  const provider = (model as { provider?: unknown }).provider;
  const api = (model as { api?: unknown }).api;
  return (
    typeof provider === "string" &&
    TENCENT_PROVIDER_IDS.has(provider) &&
    api === "openai-completions"
  );
}

export function wrapTencentProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return createPayloadPatchStreamWrapper(
    ctx.streamFn,
    ({ payload, model, options }) => {
      const requested = resolveRequestedEffort(ctx.thinkingLevel, options);
      const mapped = mapEffortForTencent(model, requested);

      if (mapped === undefined) {
        return;
      }

      if (mapped === "none" || mapped === "off") {
        payload.reasoning_effort = "none";
        return;
      }

      payload.reasoning_effort = mapped;
    },
    {
      shouldPatch: ({ model }) => isTencentCompletionsCall(model),
    },
  );
}
