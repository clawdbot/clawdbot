import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_MODEL_ALIASES } from "./cli-constants.js";

const DEFAULT_CLAUDE_MODEL_BY_FAMILY: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
};

export type ClaudeCliAnthropicModelRefs = {
  selectedRef: string;
  runtimeRefs: string[];
  rewriteRef?: string;
};

function parseProviderModelRef(
  raw: string,
  defaultProvider: string,
): { provider: string; model: string; explicitProvider: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return { provider: defaultProvider, model: trimmed, explicitProvider: false };
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return {
    provider: normalizeLowercaseStringOrEmpty(provider),
    model,
    explicitProvider: true,
  };
}

function canonicalizeKnownClaudeCliModelId(modelId: string): string | null {
  const trimmed = modelId.trim();
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("claude-")) {
    return trimmed;
  }
  const defaultModel = DEFAULT_CLAUDE_MODEL_BY_FAMILY[normalized];
  if (defaultModel) {
    return defaultModel;
  }
  const family = CLAUDE_CLI_MODEL_ALIASES[normalized];
  if (!family) {
    return null;
  }
  const version = normalized.slice(`${family}-`.length);
  if (!version || version === normalized) {
    return null;
  }
  return `claude-${family}-${version.replaceAll(".", "-")}`;
}

export function resolveClaudeCliAnthropicModelRefs(
  raw: string,
): ClaudeCliAnthropicModelRefs | null {
  const parsed = parseProviderModelRef(raw, "anthropic");
  if (!parsed) {
    return null;
  }
  if (parsed.provider !== "anthropic" && parsed.provider !== CLAUDE_CLI_BACKEND_ID) {
    return null;
  }

  const selectedRef = `anthropic/${parsed.model}`;
  const runtimeRefs = new Set<string>([selectedRef]);
  const canonicalModelId = canonicalizeKnownClaudeCliModelId(parsed.model);
  if (!parsed.explicitProvider && !canonicalModelId) {
    return null;
  }
  const rewriteRef =
    canonicalModelId || parsed.provider === CLAUDE_CLI_BACKEND_ID
      ? `anthropic/${canonicalModelId ?? parsed.model}`
      : undefined;
  if (rewriteRef) {
    runtimeRefs.add(rewriteRef);
  }

  return {
    selectedRef,
    runtimeRefs: [...runtimeRefs],
    ...(rewriteRef ? { rewriteRef } : {}),
  };
}

export function resolveKnownAnthropicModelRef(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return resolveClaudeCliAnthropicModelRefs(trimmed)?.rewriteRef ?? trimmed;
}
