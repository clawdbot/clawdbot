// Moonshot thinking wrapper normalizes reasoning output from Moonshot streams.
import { asOptionalRecord as asPayloadRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { streamSimple } from "../../stream.js";

type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
type MoonshotPayloadFinalizer = (result: unknown, payload: Record<string, unknown>) => unknown;
const MOONSHOT_ALWAYS_THINKING = {
  "kimi-k2.7-code": "low",
  "kimi-k2.7-code-highspeed": "low",
  "kimi-k3": "max",
} as const;
const FIXED_SAMPLING_FIELDS = "temperature top_p n presence_penalty frequency_penalty".split(" ");
type MoonshotAlwaysThinkingEffort = "low" | "max";

function normalizeMoonshotThinkingType(value: unknown): MoonshotThinkingType | undefined {
  const type = asPayloadRecord(value)?.type ?? value;
  if (typeof type === "boolean") {
    return type ? "enabled" : "disabled";
  }
  const normalized = normalizeOptionalLowercaseString(type);
  if (["enabled", "enable", "on", "true"].includes(normalized ?? "")) {
    return "enabled";
  }
  if (["disabled", "disable", "off", "false"].includes(normalized ?? "")) {
    return "disabled";
  }
  return undefined;
}

function isMoonshotToolChoiceCompatible(toolChoice: unknown): boolean {
  const type = asPayloadRecord(toolChoice)?.type ?? toolChoice;
  return type == null || type === "auto" || type === "none";
}

function ensureMoonshotToolCallReasoningContent(payload: Record<string, unknown>): void {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    const record = asPayloadRecord(message);
    if (record?.role !== "assistant" || !Array.isArray(record.tool_calls)) {
      continue;
    }
    if (record.tool_calls.length > 0 && !("reasoning_content" in record)) {
      record.reasoning_content = "";
    }
  }
}

function resolveAlwaysThinkingEffort(
  modelId: string,
  directMoonshotModel: boolean,
): MoonshotAlwaysThinkingEffort | undefined {
  const effort = MOONSHOT_ALWAYS_THINKING[modelId as keyof typeof MOONSHOT_ALWAYS_THINKING];
  return effort && (modelId !== "kimi-k3" || directMoonshotModel) ? effort : undefined;
}

function sanitizeAlwaysThinkingPayload(
  payload: Record<string, unknown>,
  effort: MoonshotAlwaysThinkingEffort,
): void {
  delete payload.thinking;
  delete payload.reasoningEffort;
  FIXED_SAMPLING_FIELDS.forEach((field) => Reflect.deleteProperty(payload, field));
  if (effort === "max") {
    payload.reasoning_effort = effort;
  } else {
    delete payload.reasoning_effort;
    if (!isMoonshotToolChoiceCompatible(payload.tool_choice)) {
      payload.tool_choice = "auto";
    }
  }
}

function prepareThinkingPayload(
  payload: Record<string, unknown>,
  modelId: string,
  directMoonshotModel: boolean,
  thinkingType?: MoonshotThinkingType,
  thinkingKeep?: MoonshotThinkingKeep,
) {
  const payloadModelId =
    typeof payload.model === "string" ? payload.model.trim().toLowerCase() : modelId;
  let effectiveThinkingType = normalizeMoonshotThinkingType(payload.thinking);
  if (thinkingType) {
    payload.thinking = { type: thinkingType };
    effectiveThinkingType = thinkingType;
  }
  const effort = resolveAlwaysThinkingEffort(payloadModelId, directMoonshotModel);
  if (effort) {
    sanitizeAlwaysThinkingPayload(payload, effort);
    return (finalPayload: Record<string, unknown>) => {
      sanitizeAlwaysThinkingPayload(finalPayload, effort);
      ensureMoonshotToolCallReasoningContent(finalPayload);
    };
  }
  if (effectiveThinkingType === "enabled" && !isMoonshotToolChoiceCompatible(payload.tool_choice)) {
    const toolChoiceType = asPayloadRecord(payload.tool_choice)?.type;
    if (payload.tool_choice === "required") {
      payload.tool_choice = "auto";
    } else if (toolChoiceType === "tool" || toolChoiceType === "function") {
      payload.thinking = { type: "disabled" };
      effectiveThinkingType = "disabled";
    }
  }
  const thinking = asPayloadRecord(payload.thinking);
  const preserveKeep =
    payloadModelId === "kimi-k2.6" && effectiveThinkingType === "enabled" && thinkingKeep === "all";
  if (thinking) {
    delete thinking.keep;
    Object.assign(thinking, preserveKeep ? { keep: "all" } : {});
  }
  return effectiveThinkingType === "enabled"
    ? ensureMoonshotToolCallReasoningContent
    : () => undefined;
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined {
  return (
    normalizeMoonshotThinkingType(params.configuredThinking) ??
    (params.thinkingLevel ? (params.thinkingLevel === "off" ? "disabled" : "enabled") : undefined)
  );
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function resolveMoonshotThinkingKeep(params: {
  configuredThinking: unknown;
}): MoonshotThinkingKeep | undefined {
  const keep = normalizeOptionalLowercaseString(asPayloadRecord(params.configuredThinking)?.keep);
  return keep === "all" ? "all" : undefined;
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType?: MoonshotThinkingType,
  thinkingKeep?: MoonshotThinkingKeep,
  finalizePayload?: MoonshotPayloadFinalizer,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return function moonshotThinkingStream(model, context, options) {
    const modelId = model.id.trim().toLowerCase();
    const directMoonshotModel = normalizeOptionalLowercaseString(model.provider) === "moonshot";
    const alwaysThinkingEffort = resolveAlwaysThinkingEffort(modelId, directMoonshotModel);
    const streamModel = alwaysThinkingEffort ? { ...model, reasoning: true } : model;
    const streamOptions = alwaysThinkingEffort
      ? { ...options, reasoning: alwaysThinkingEffort }
      : options;
    return underlying(streamModel, context, {
      ...streamOptions,
      onPayload(payload, payloadModel) {
        const record = asPayloadRecord(payload);
        if (!record) {
          return streamOptions?.onPayload?.(payload, payloadModel);
        }
        const postThinking = prepareThinkingPayload(
          record,
          modelId,
          directMoonshotModel,
          thinkingType,
          thinkingKeep,
        );
        const finish = (result: unknown) => {
          const finalPayload = asPayloadRecord(result) ?? record;
          postThinking(finalPayload);
          return finalizePayload ? finalizePayload(result, finalPayload) : result;
        };
        const result = streamOptions?.onPayload?.(payload, payloadModel);
        return result && typeof (result as Promise<unknown>).then === "function"
          ? Promise.resolve(result).then(finish)
          : finish(result);
      },
    });
  };
}
