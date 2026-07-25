/**
 * Thinking-level policy for Claude models on Amazon Bedrock. It maps Bedrock
 * model ids to the provider SDK thinking levels that are actually supported.
 */
import type {
  ProviderRuntimeModel,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "openclaw/plugin-sdk/provider-model-shared";

const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

function isOpus48BedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?(?:anthropic\.)?claude-opus-4[.-]8(?:$|[-.:/])/i.test(
    modelRef,
  );
}

function isOpus46BedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?(?:anthropic\.)?claude-opus-4[.-]6(?:$|[-.:/])/i.test(
    modelRef,
  );
}

/** Return whether a Bedrock model ref names Claude Opus 4.7. */
function isOpus47BedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?(?:anthropic\.)?claude-opus-4[.-]7(?:$|[-.:/])/i.test(
    modelRef,
  );
}

/** Return whether a Bedrock model ref names Claude Opus 4.7 or newer. */
export function isOpus47OrNewerBedrockModelRef(modelRef: string): boolean {
  return isOpus47BedrockModelRef(modelRef) || isOpus48BedrockModelRef(modelRef);
}

function isMythosPreviewBedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?(?:anthropic\.)?claude-mythos-preview(?:$|[-.:/])/i.test(
    modelRef,
  );
}

/** Return whether a Bedrock Claude ref needs latest adaptive-thinking request shaping. */
export function isLatestAdaptiveBedrockModelRef(
  modelId: string,
  params?: Record<string, unknown>,
): boolean {
  const modelRef = { id: modelId, params };
  const canonicalModelId = resolveClaudeModelIdentity(modelRef);
  return (
    resolveClaudeFable5ModelIdentity(modelRef) !== undefined ||
    resolveClaudeMythos5ModelIdentity(modelRef) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(modelRef) !== undefined ||
    resolveClaudeOpus5ModelIdentity(modelRef) !== undefined ||
    [modelId, canonicalModelId].some(
      (candidate) =>
        isOpus47OrNewerBedrockModelRef(candidate) || isMythosPreviewBedrockModelRef(candidate),
    )
  );
}

/** Return whether a Bedrock Claude ref supports max effort. */
export function supportsBedrockNativeMaxEffort(
  modelId: string,
  params?: Record<string, unknown>,
): boolean {
  if (
    resolveClaudeFable5ModelIdentity({ id: modelId, params }) ||
    resolveClaudeMythos5ModelIdentity({ id: modelId, params }) ||
    resolveClaudeSonnet5ModelIdentity({ id: modelId, params }) ||
    resolveClaudeOpus5ModelIdentity({ id: modelId, params })
  ) {
    return true;
  }
  const canonicalModelId = resolveClaudeModelIdentity({ id: modelId, params });
  return [modelId, canonicalModelId].some(
    (modelRef) => isOpus46BedrockModelRef(modelRef) || isOpus47OrNewerBedrockModelRef(modelRef),
  );
}

/** Resolve route-specific native effort mappings for Bedrock Claude models. */
export function resolveBedrockNativeThinkingLevelMap(
  modelId: string,
  params?: Record<string, unknown>,
): ProviderRuntimeModel["thinkingLevelMap"] | undefined {
  const modelRef = { id: modelId, params };
  if (resolveClaudeFable5ModelIdentity(modelRef) || resolveClaudeMythos5ModelIdentity(modelRef)) {
    return { off: "low", minimal: "low", xhigh: "xhigh", max: "max" };
  }
  if (resolveClaudeSonnet5ModelIdentity(modelRef) || resolveClaudeOpus5ModelIdentity(modelRef)) {
    return { off: "low", minimal: "low", xhigh: "xhigh", max: "max" };
  }
  if (!supportsBedrockNativeMaxEffort(modelId, params)) {
    return undefined;
  }
  const canonicalModelId = resolveClaudeModelIdentity(modelRef);
  return {
    xhigh: [modelId, canonicalModelId].some(isOpus47OrNewerBedrockModelRef) ? "xhigh" : null,
    max: "max",
  };
}

/** Resolve supported Claude thinking levels for a Bedrock model id. */
export function resolveBedrockClaudeThinkingProfile(
  modelId: string,
  params?: Record<string, unknown>,
): ProviderThinkingProfile {
  const trimmed = modelId.trim();
  const canonicalModelId = resolveClaudeModelIdentity({ id: trimmed, params });
  const modelRefs = [trimmed, canonicalModelId];
  if (
    resolveClaudeFable5ModelIdentity({ id: trimmed, params }) ||
    resolveClaudeMythos5ModelIdentity({ id: trimmed, params }) ||
    resolveClaudeSonnet5ModelIdentity({ id: trimmed, params }) ||
    resolveClaudeOpus5ModelIdentity({ id: trimmed, params })
  ) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (modelRefs.some(isOpus48BedrockModelRef)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (modelRefs.some(isOpus47BedrockModelRef)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (modelRefs.some(isOpus46BedrockModelRef)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "adaptive",
    };
  }
  if (modelRefs.some(isMythosPreviewBedrockModelRef)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }],
      defaultLevel: "adaptive",
    };
  }
  if (modelRefs.some((modelRef) => /claude-sonnet-4(?:\.|-)6(?:$|[-.])/i.test(modelRef))) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }],
      defaultLevel: "adaptive",
    };
  }
  return { levels: BASE_CLAUDE_THINKING_LEVELS };
}
