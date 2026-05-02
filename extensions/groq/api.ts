import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";

const GROQ_QWEN3_32B_ID = "qwen/qwen3-32b";
const GROQ_GPT_OSS_REASONING_IDS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
]);

const GROQ_QWEN_REASONING_EFFORTS = ["none", "default"] as const;
const GROQ_GPT_OSS_REASONING_EFFORTS = ["low", "medium", "high"] as const;

const GROQ_QWEN_REASONING_EFFORT_MAP: Record<string, string> = {
  off: "none",
  none: "none",
  minimal: "default",
  low: "default",
  medium: "default",
  high: "default",
  xhigh: "default",
  adaptive: "default",
  max: "default",
};

function normalizeGroqModelId(modelId: string | undefined): string {
  return modelId?.trim().toLowerCase() ?? "";
}

export function resolveGroqReasoningCompatPatch(
  modelId: string,
): Pick<
  ModelCompatConfig,
  "supportsReasoningEffort" | "supportedReasoningEfforts" | "reasoningEffortMap"
> | null {
  const normalized = normalizeGroqModelId(modelId);
  if (normalized === GROQ_QWEN3_32B_ID) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: [...GROQ_QWEN_REASONING_EFFORTS],
      reasoningEffortMap: GROQ_QWEN_REASONING_EFFORT_MAP,
    };
  }
  if (GROQ_GPT_OSS_REASONING_IDS.has(normalized)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: [...GROQ_GPT_OSS_REASONING_EFFORTS],
    };
  }
  return null;
}

export function contributeGroqResolvedModelCompat(params: {
  modelId: string;
  model: { api?: unknown; provider?: unknown };
}): Partial<ModelCompatConfig> | undefined {
  if (params.model.api !== "openai-completions" || params.model.provider !== "groq") {
    return undefined;
  }
  return resolveGroqReasoningCompatPatch(params.modelId) ?? undefined;
}
