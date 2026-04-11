import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

type MoonshotThinkingType = "enabled" | "disabled";
let piAiRuntimePromise: Promise<typeof import("@mariozechner/pi-ai")> | undefined;

async function loadDefaultStreamFn(): Promise<StreamFn> {
  piAiRuntimePromise ??= import("@mariozechner/pi-ai");
  const runtime = await piAiRuntimePromise;
  return runtime.streamSimple;
}

function normalizeMoonshotThinkingType(value: unknown): MoonshotThinkingType | undefined {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (typeof value === "string") {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
      return undefined;
    }
    if (["enabled", "enable", "on", "true"].includes(normalized)) {
      return "enabled";
    }
    if (["disabled", "disable", "off", "false"].includes(normalized)) {
      return "disabled";
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeMoonshotThinkingType((value as Record<string, unknown>).type);
  }
  return undefined;
}

function isMoonshotToolChoiceCompatible(toolChoice: unknown): boolean {
  if (toolChoice == null || toolChoice === "auto" || toolChoice === "none") {
    return true;
  }
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const typeValue = (toolChoice as Record<string, unknown>).type;
    return typeValue === "auto" || typeValue === "none";
  }
  return false;
}

function isPinnedToolChoice(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return false;
  }
  const typeValue = (toolChoice as Record<string, unknown>).type;
  return typeValue === "tool" || typeValue === "function";
}

export function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined {
  const configured = normalizeMoonshotThinkingType(params.configuredThinking);
  if (configured) {
    return configured;
  }
  if (!params.thinkingLevel) {
    return undefined;
  }
  return params.thinkingLevel === "off" ? "disabled" : "enabled";
}

export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType?: MoonshotThinkingType,
): StreamFn {
  return async (model, context, options) => {
    const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      let effectiveThinkingType = normalizeMoonshotThinkingType(payloadObj.thinking);

      if (thinkingType) {
        payloadObj.thinking = { type: thinkingType };
        effectiveThinkingType = thinkingType;
      }

      if (
        effectiveThinkingType === "enabled" &&
        !isMoonshotToolChoiceCompatible(payloadObj.tool_choice)
      ) {
        if (payloadObj.tool_choice === "required") {
          payloadObj.tool_choice = "auto";
        } else if (isPinnedToolChoice(payloadObj.tool_choice)) {
          payloadObj.thinking = { type: "disabled" };
        }
      }
    });
  };
}
