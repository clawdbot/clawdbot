/**
 * Stream option extensions and prompt-cache policy for Amazon Bedrock models.
 * Provider registration and runtime streaming share these contracts.
 */
import type { CachePointBlock } from "@aws-sdk/client-bedrock-runtime";
import type {
  CacheRetention,
  Model,
  ModelThinkingLevel,
  StreamOptions,
  ThinkingBudgets,
} from "openclaw/plugin-sdk/llm";
import { resolveClaudeModelIdentity } from "openclaw/plugin-sdk/provider-model-shared";

export function resolveBedrockPromptCachePolicy(
  model: Pick<Model, "id" | "params"> & { name?: string },
): "nova" | "claude" | undefined {
  // AWS Nova model cards allow system/messages checkpoints with a five-minute TTL.
  // Only unwrap foundation models and system profiles; application profiles stay opaque.
  const modelId = model.id
    .trim()
    .toLowerCase()
    .replace(
      /^arn:aws(?:-cn|-us-gov)?:bedrock:[^:]+:[^:]*:(?:foundation-model|inference-profile)\//,
      "",
    )
    .replace(/^(?:us|eu|apac|jp|global)\./, "");
  if (/^amazon\.nova-(?:micro|lite|pro|premier|2-lite)-v1:0$/.test(modelId)) {
    return "nova";
  }
  if (
    supportsBedrockClaudePromptCaching(model.id, model.name) ||
    supportsBedrockClaudePromptCaching(resolveClaudeModelIdentity(model), model.name)
  ) {
    return "claude";
  }
  return undefined;
}

export function resolveBedrockCachePoint(
  model: Pick<Model, "id" | "params"> & { name?: string },
  retention: CacheRetention,
): CachePointBlock | undefined {
  const policy = resolveBedrockPromptCachePolicy(model);
  if (!policy || retention === "none") {
    return undefined;
  }
  return {
    type: "default",
    ...(policy === "claude" && retention === "long" ? { ttl: "1h" } : {}),
  };
}

/** How Bedrock thinking output should be displayed to users. */
type BedrockThinkingDisplay = "summarized" | "omitted";

/** Extra Bedrock-specific stream options accepted by the provider runtime. */
export interface BedrockOptions extends StreamOptions {
  region?: string;
  profile?: string;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  reasoning?: ModelThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  interleavedThinking?: boolean;
  thinkingDisplay?: BedrockThinkingDisplay;
  requestMetadata?: Record<string, string>;
  bearerToken?: string;
}

function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
}

/** Return whether a Bedrock model is known to support Anthropic prompt caching. */
export function supportsBedrockClaudePromptCaching(modelId: string, modelName?: string): boolean {
  const candidates = getModelMatchCandidates(modelId, modelName);
  const hasClaudeRef = candidates.some((s) => s.includes("claude"));
  if (!hasClaudeRef) {
    if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1") {
      return true;
    }
    return false;
  }
  if (candidates.some((s) => s.includes("-4-"))) {
    return true;
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.includes("claude-fable-5") ||
        candidate.includes("claude-mythos-5") ||
        candidate.includes("claude-opus-5") ||
        candidate.includes("claude-sonnet-5"),
    )
  ) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-3-5-haiku"))) {
    return true;
  }
  return false;
}
