// Github Copilot plugin module implements model metadata behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { supportsClaudeAdaptiveThinking } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type CopilotRuntimeApi = "anthropic-messages" | "openai-completions" | "openai-responses";
type CopilotReasoningCompat = {
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: readonly string[] | null;
};

// Provider-owned general-purpose preference. Setup verifies it against the
// authenticated live catalog instead of assuming every account can use it.
export const DEFAULT_COPILOT_MODEL = "github-copilot/claude-sonnet-5";

const COPILOT_CHAT_COMPLETIONS_COMPAT: ModelDefinitionConfig["compat"] = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
};
const manifestCatalog = manifest.modelCatalog.providers["github-copilot"];
const manifestModels = buildManifestModelProviderConfig({
  providerId: "github-copilot",
  catalog: manifestCatalog,
}).models;

const STATIC_MODEL_OVERRIDES = new Map<string, Partial<ModelDefinitionConfig>>([
  ...manifestModels.map((model) => [model.id, model] as const),
  // These two non-catalog ids preserve metadata for legacy configured refs and
  // account discovery responses. They are intentionally not picker entries.
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

export function resolveCopilotThinkingLevelMap(
  modelId: string,
  compat?: CopilotReasoningCompat | null,
  api?: string | null,
): ModelDefinitionConfig["thinkingLevelMap"] | undefined {
  const normalizedModelId = normalizeOptionalLowercaseString(modelId) ?? "";
  const runtimeApi = api ?? resolveCopilotTransportApi(normalizedModelId);
  const staticCompat = resolveStaticCopilotModelOverride(normalizedModelId)?.compat;
  // A declared account catalog is authoritative, including explicit opt-outs;
  // the manifest only supplies effort metadata when discovery has none.
  const efforts =
    compat?.supportsReasoningEffort === false
      ? []
      : (compat?.supportedReasoningEfforts ?? staticCompat?.supportedReasoningEfforts);
  if (!Array.isArray(efforts)) {
    return undefined;
  }
  const supported = new Set(efforts.map(normalizeOptionalLowercaseString));
  const supportsEffort =
    runtimeApi !== "anthropic-messages" ||
    supportsClaudeAdaptiveThinking({ id: normalizedModelId });
  return {
    // Keep the public minimal setting usable when this route starts its native ladder at low.
    ...(runtimeApi === "openai-responses" && !supported.has("minimal") && supported.has("low")
      ? { minimal: "low" }
      : {}),
    xhigh: supportsEffort && supported.has("xhigh") ? "xhigh" : null,
    // Chat Completions currently translates max to xhigh rather than preserving it.
    max:
      supportsEffort && runtimeApi !== "openai-completions" && supported.has("max") ? "max" : null,
  };
}

export function resolveStaticCopilotModelOverride(
  modelId: string,
): Partial<ModelDefinitionConfig> | undefined {
  return STATIC_MODEL_OVERRIDES.get(normalizeOptionalLowercaseString(modelId) ?? "");
}
