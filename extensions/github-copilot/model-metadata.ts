// Github Copilot plugin module implements model metadata behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { supportsClaudeAdaptiveThinking } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

type CopilotRuntimeApi = "anthropic-messages" | "openai-completions" | "openai-responses";
type CopilotReasoningCompat = {
  supportedReasoningEfforts?: readonly string[] | null;
};

const COPILOT_CHAT_COMPLETIONS_COMPAT: ModelDefinitionConfig["compat"] = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
};
const COPILOT_XHIGH_MODEL_IDS = new Set(["gpt-5.4", "gpt-5.3-codex"]);

const STATIC_MODEL_OVERRIDES = new Map<string, Partial<ModelDefinitionConfig>>([
  [
    "claude-opus-4.6-1m",
    {
      name: "Claude Opus 4.6 (1M context)",
      api: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      thinkingLevelMap: { xhigh: null, max: null },
      compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
    },
  ],
  [
    "claude-opus-4.7-1m-internal",
    {
      name: "Claude Opus 4.7 (1M context)",
      api: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      thinkingLevelMap: { xhigh: "xhigh", max: null },
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    },
  ],
  [
    "gpt-5.5",
    {
      name: "GPT-5.5",
      reasoning: true,
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    },
  ],
]);

function isCopilotGeminiModelId(modelId: string): boolean {
  return /(?:^|[-_.])gemini(?:$|[-_.])/.test(modelId);
}

function isCopilotClaude45ModelId(modelId: string): boolean {
  return /^claude-(?:haiku|opus|sonnet)-4[.-]5(?:$|[-.])/.test(modelId);
}

export function resolveCopilotTransportApi(modelId: string): CopilotRuntimeApi {
  const normalized = normalizeOptionalLowercaseString(modelId) ?? "";
  if (normalized.includes("claude")) {
    return "anthropic-messages";
  }
  if (isCopilotGeminiModelId(normalized)) {
    return "openai-completions";
  }
  return "openai-responses";
}

export function resolveCopilotModelCompat(
  modelId: string,
): ModelDefinitionConfig["compat"] | undefined {
  const normalized = normalizeOptionalLowercaseString(modelId) ?? "";
  if (isCopilotGeminiModelId(normalized)) {
    return { ...COPILOT_CHAT_COMPLETIONS_COMPAT };
  }
  // Copilot's Claude 4.5 endpoints reject Anthropic's eager tool extension,
  // while current Claude 4.6+ endpoints accept it.
  if (isCopilotClaude45ModelId(normalized)) {
    return { supportsEagerToolInputStreaming: false };
  }
  return undefined;
}

function compatSupportsEffort(
  compat: CopilotReasoningCompat | null | undefined,
  effort: "xhigh" | "max",
): boolean {
  return (
    Array.isArray(compat?.supportedReasoningEfforts) &&
    compat.supportedReasoningEfforts.some(
      (candidate) => normalizeOptionalLowercaseString(candidate) === effort,
    )
  );
}

export function resolveCopilotExtendedThinkingLevels(
  modelId: string,
  compat?: CopilotReasoningCompat | null,
): Array<"xhigh" | "max"> {
  const normalizedModelId = normalizeOptionalLowercaseString(modelId) ?? "";
  const staticCompat = resolveStaticCopilotModelOverride(normalizedModelId)?.compat;
  const isClaudeModel = normalizedModelId.includes("claude");
  const supportsAdaptiveClaudeEffort =
    !isClaudeModel || supportsClaudeAdaptiveThinking({ id: normalizedModelId });
  const levels: Array<"xhigh" | "max"> = [];
  if (
    supportsAdaptiveClaudeEffort &&
    (COPILOT_XHIGH_MODEL_IDS.has(normalizedModelId) ||
      compatSupportsEffort(compat, "xhigh") ||
      compatSupportsEffort(staticCompat, "xhigh"))
  ) {
    levels.push("xhigh");
  }
  if (
    isClaudeModel &&
    supportsAdaptiveClaudeEffort &&
    (compatSupportsEffort(compat, "max") || compatSupportsEffort(staticCompat, "max"))
  ) {
    levels.push("max");
  }
  return levels;
}

export function resolveStaticCopilotModelOverride(
  modelId: string,
): Partial<ModelDefinitionConfig> | undefined {
  return STATIC_MODEL_OVERRIDES.get(normalizeOptionalLowercaseString(modelId) ?? "");
}
