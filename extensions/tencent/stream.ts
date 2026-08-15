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

const TENCENT_REASONING_EFFORT_MAP: Readonly<Record<string, string>> = Object.freeze({
  off: "none",
  none: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
});

const TOKENHUB_HY3_PREVIEW_REASONING_EFFORTS = new Set(["none", "low", "high"]);

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
  if (
    (model as { provider?: unknown }).provider === TOKENHUB_PROVIDER_ID &&
    (model as { id?: unknown }).id === "hy3-preview"
  ) {
    if (effort === "off") {
      return "none";
    }
    // Preview supports low directly. Leave unsupported requests to the shared
    // model fallback that already normalized the underlying payload.
    return TOKENHUB_HY3_PREVIEW_REASONING_EFFORTS.has(effort) ? effort : undefined;
  }
  return TENCENT_REASONING_EFFORT_MAP[effort];
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
