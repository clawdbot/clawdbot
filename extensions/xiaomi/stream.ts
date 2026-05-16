import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createThinkingOnlyFinalTextWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isMiMoReasoningModelRef } from "./thinking.js";

const MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS = new Set(["mimo-v2-pro", "mimo-v2-omni"]);

function normalizeMiMoModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase().split(":", 1)[0];
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function shouldPromoteMiMoReasoningToVisibleText(model: Parameters<StreamFn>[0]): boolean {
  return (
    model.provider === "xiaomi" &&
    MIMO_REASONING_AS_VISIBLE_TEXT_MODEL_IDS.has(normalizeMiMoModelId(model.id) ?? "")
  );
}

export function createMiMoThinkingWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  const wrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: isMiMoReasoningModelRef,
  });
  // Legacy MiMo V2 can put the final user-visible answer in reasoning_content.
  // Only promote terminal thinking-only output; replay/tool-call reasoning stays untouched.
  return createThinkingOnlyFinalTextWrapper({
    baseStreamFn: wrapped,
    shouldPatchModel: shouldPromoteMiMoReasoningToVisibleText,
  });
}
