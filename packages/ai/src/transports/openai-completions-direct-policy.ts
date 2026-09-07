import type { OpenAICompletionsOptions } from "../provider-options.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";

export function applyDirectCompletionsReasoningAndRouting(
  params: Record<string, unknown>,
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
  compat: ResolvedOpenAICompletionsCompat,
): void {
  // Provider compat is authoritative; keep model-level and literal values as fallbacks
  // for catalogs that have not adopted reasoningEffortMap.
  const reasoningEffortMap = resolveOpenAIReasoningEffortMap(model);
  const thinkingLevelMap:
    | Partial<Record<NonNullable<OpenAICompletionsOptions["reasoningEffort"]>, string | null>>
    | undefined = model.thinkingLevelMap;
  const offReasoningEffort = reasoningEffortMap.off ?? model.thinkingLevelMap?.off;
  const reasoningEffort =
    options?.reasoningEffort === undefined
      ? (offReasoningEffort ?? undefined)
      : (reasoningEffortMap[options.reasoningEffort] ??
        thinkingLevelMap?.[options.reasoningEffort] ??
        options.reasoningEffort);
  const reasoningEnabled = reasoningEffort !== undefined && reasoningEffort !== "none";

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.thinking = reasoningEnabled
      ? { type: "enabled", clear_thinking: false }
      : { type: "disabled" };
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = reasoningEnabled;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = {
      enable_thinking: reasoningEnabled,
      preserve_thinking: true,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = { type: reasoningEnabled ? "enabled" : "disabled" };
    if (reasoningEnabled && compat.supportsReasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    if (reasoningEnabled) {
      params.reasoning = { effort: reasoningEffort };
    } else if (offReasoningEffort !== null) {
      params.reasoning = { effort: offReasoningEffort ?? "none" };
    }
  } else if (compat.thinkingFormat === "together" && model.reasoning) {
    params.reasoning = { enabled: reasoningEnabled };
    if (reasoningEnabled && compat.supportsReasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }
  } else if (reasoningEnabled && model.reasoning && compat.supportsReasoningEffort) {
    // OpenAI-style reasoning_effort
    params.reasoning_effort = reasoningEffort;
  } else if (model.reasoning && compat.supportsReasoningEffort) {
    if (typeof offReasoningEffort === "string") {
      params.reasoning_effort = offReasoningEffort;
    }
  }

  // OpenRouter provider routing preferences
  if (compat.openRouterRouting) {
    params.provider = compat.openRouterRouting;
  }

  // Vercel AI Gateway provider routing preferences
  if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      const gatewayOptions: Record<string, string[]> = {};
      if (routing.only) {
        gatewayOptions.only = routing.only;
      }
      if (routing.order) {
        gatewayOptions.order = routing.order;
      }
      params.providerOptions = { gateway: gatewayOptions };
    }
  }
}
