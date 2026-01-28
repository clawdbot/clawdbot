import { isAntigravityClaude, isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import { normalizeProviderId } from "./model-selection.js";
import type { ToolCallIdMode } from "./tool-call-id.js";

export type TranscriptSanitizeMode = "full" | "images-only";

export type TranscriptPolicy = {
  sanitizeMode: TranscriptSanitizeMode;
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  normalizeAntigravityThinkingBlocks: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

const MISTRAL_MODEL_HINTS = [
  "mistral",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
  "mistralai",
];
const OPENAI_MODEL_APIS = new Set([
  "openai",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);
const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);

function isOpenAiApi(modelApi?: string | null): boolean {
  if (!modelApi) return false;
  return OPENAI_MODEL_APIS.has(modelApi);
}

function isOpenAiProvider(provider?: string | null): boolean {
  if (!provider) return false;
  return OPENAI_PROVIDERS.has(normalizeProviderId(provider));
}

function isAnthropicApi(modelApi?: string | null, provider?: string | null): boolean {
  if (modelApi === "anthropic-messages") return true;
  const normalized = normalizeProviderId(provider ?? "");
  // MiniMax now uses openai-completions API, not anthropic-messages
  return normalized === "anthropic";
}

function isMistralModel(params: { provider?: string | null; modelId?: string | null }): boolean {
  const provider = normalizeProviderId(params.provider ?? "");
  if (provider === "mistral") return true;
  const modelId = (params.modelId ?? "").toLowerCase();
  if (!modelId) return false;
  return MISTRAL_MODEL_HINTS.some((hint) => modelId.includes(hint));
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const modelId = params.modelId ?? "";
  const isGoogle = isGoogleModelApi(params.modelApi);
  const isAnthropic = isAnthropicApi(params.modelApi, provider);
  const isOpenAi = isOpenAiProvider(provider) || (!provider && isOpenAiApi(params.modelApi));
  const isMistral = isMistralModel({ provider, modelId });
  const isOpenRouterGemini =
    (provider === "openrouter" || provider === "opencode") &&
    modelId.toLowerCase().includes("gemini");
  const isAntigravityClaudeModel = isAntigravityClaude({
    api: params.modelApi,
    provider,
    modelId,
  });

  const needsNonImageSanitize = isGoogle || isAnthropic || isMistral || isOpenRouterGemini;

  const sanitizeToolCallIds = isGoogle || isMistral;
  const toolCallIdMode: ToolCallIdMode | undefined = isMistral
    ? "strict9"
    : sanitizeToolCallIds
      ? "strict"
      : undefined;
  const repairToolUseResultPairing = isGoogle || isAnthropic;
  const sanitizeThoughtSignatures = isOpenRouterGemini
    ? { allowBase64Only: true, includeCamelCase: true }
    : undefined;
  const normalizeAntigravityThinkingBlocks = isAntigravityClaudeModel;

  return {
    sanitizeMode: isOpenAi ? "images-only" : needsNonImageSanitize ? "full" : "images-only",
    sanitizeToolCallIds: !isOpenAi && sanitizeToolCallIds,
    toolCallIdMode,
    repairToolUseResultPairing: !isOpenAi && repairToolUseResultPairing,
    preserveSignatures: isAntigravityClaudeModel,
    sanitizeThoughtSignatures: isOpenAi ? undefined : sanitizeThoughtSignatures,
    normalizeAntigravityThinkingBlocks,
    applyGoogleTurnOrdering: !isOpenAi && isGoogle,
    validateGeminiTurns: !isOpenAi && isGoogle,
    validateAnthropicTurns: !isOpenAi && isAnthropic,
    allowSyntheticToolResults: !isOpenAi && (isGoogle || isAnthropic),
  };
}
