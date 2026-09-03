/**
 * Claude CLI model-ref normalization. It maps family aliases and retired model
 * ids to current Anthropic runtime refs while preserving auth-profile suffixes.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_MODEL_ID_ALIASES } from "./cli-constants.js";

/** Normalized Claude CLI selection plus runtime refs used by setup migrations. */
type ClaudeCliAnthropicModelRefs = {
  selectedRef: string;
  runtimeRefs: string[];
  rewriteRef?: string;
};

function splitTrailingModelAuthProfile(raw: string): { model: string; profile?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }
  const lastSlash = trimmed.lastIndexOf("/");
  let delimiter = trimmed.indexOf("@", lastSlash + 1);
  if (delimiter <= 0) {
    return { model: trimmed };
  }
  if (/^\d{8}(?:@|$)/.test(trimmed.slice(delimiter + 1))) {
    const nextDelimiter = trimmed.indexOf("@", delimiter + 9);
    if (nextDelimiter < 0) {
      return { model: trimmed };
    }
    delimiter = nextDelimiter;
  }
  const model = trimmed.slice(0, delimiter).trim();
  const profile = trimmed.slice(delimiter + 1).trim();
  return model && profile ? { model, profile } : { model: trimmed };
}

function attachModelAuthProfile(model: string, profile?: string): string {
  return profile ? `${model}@${profile}` : model;
}

function hasRetiredVersionPrefix(normalized: string, prefix: string): boolean {
  if (normalized === prefix) {
    return true;
  }
  if (!normalized.startsWith(prefix)) {
    return false;
  }
  const next = normalized[prefix.length];
  return next === "-" || next === "." || next === ":" || next === "@";
}

function hasAnyRetiredVersionPrefix(normalized: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => hasRetiredVersionPrefix(normalized, prefix));
}

export function normalizeAnthropicProviderId(provider: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(provider);
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  return normalized;
}

export function parseAnthropicModelRef(
  raw: string,
): { provider: string; model: string; explicitProvider: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return { provider: "anthropic", model: trimmed, explicitProvider: false };
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return {
    provider: normalizeAnthropicProviderId(provider),
    model,
    explicitProvider: true,
  };
}

function canonicalizeKnownClaudeCliModelId(modelId: string): string | null {
  const split = splitTrailingModelAuthProfile(modelId);
  const trimmed = split.model.trim();
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (!normalized) {
    return null;
  }
  const upgraded = upgradeOldClaudeModelId(normalized);
  if (upgraded) {
    return attachModelAuthProfile(upgraded, split.profile);
  }
  if (normalized.startsWith("claude-")) {
    return attachModelAuthProfile(trimmed, split.profile);
  }
  const aliasedModel = CLAUDE_MODEL_ID_ALIASES.get(normalized);
  return aliasedModel ? attachModelAuthProfile(aliasedModel, split.profile) : null;
}

function upgradeOldClaudeModelId(normalized: string): string | null {
  // Current Claude families, including Haiku, must never be migrated.
  if (
    hasRetiredVersionPrefix(normalized, "claude-opus-5") ||
    [
      "claude-opus-4-8",
      "claude-opus-4.8",
      "claude-opus-4-7",
      "claude-opus-4.7",
      "claude-opus-4-6",
      "claude-opus-4.6",
      "claude-sonnet-4-6",
      "claude-sonnet-4.6",
      "claude-haiku-4-5",
      "claude-haiku-4.5",
    ].some((prefix) => normalized.startsWith(prefix))
  ) {
    return null;
  }
  if (
    normalized === "claude-opus-4" ||
    hasAnyRetiredVersionPrefix(normalized, [
      "claude-opus-4-5",
      "claude-opus-4.5",
      "claude-opus-4-1",
      "claude-opus-4.1",
      "claude-opus-4-0",
      "claude-opus-4.0",
    ]) ||
    /^claude-opus-4-20\d{6}/.test(normalized)
  ) {
    return "claude-opus-5";
  }
  if (
    normalized === "claude-sonnet-4" ||
    hasAnyRetiredVersionPrefix(normalized, [
      "claude-sonnet-4-5",
      "claude-sonnet-4.5",
      "claude-sonnet-4-1",
      "claude-sonnet-4.1",
      "claude-sonnet-4-0",
      "claude-sonnet-4.0",
    ]) ||
    /^claude-sonnet-4-20\d{6}/.test(normalized)
  ) {
    return "claude-sonnet-4-6";
  }
  if (normalized.startsWith("claude-3") && normalized.includes("opus")) {
    return "claude-opus-5";
  }
  if (
    normalized.startsWith("claude-3") &&
    (normalized.includes("sonnet") || normalized.includes("haiku"))
  ) {
    return "claude-sonnet-4-6";
  }
  if (["opus-4.5", "opus-4.1", "opus-4", "opus-3"].includes(normalized)) {
    return "claude-opus-5";
  }
  if (
    [
      "sonnet-4.5",
      "sonnet-4.1",
      "sonnet-4.0",
      "sonnet-4",
      "sonnet-3.7",
      "sonnet-3.5",
      "sonnet-3",
      "haiku-3.5",
      "haiku-3",
    ].includes(normalized)
  ) {
    return "claude-sonnet-4-6";
  }
  return null;
}

/** Resolve a Claude CLI model ref into selected and Anthropic-compatible runtime refs. */
export function resolveClaudeCliAnthropicModelRefs(
  raw: string,
): ClaudeCliAnthropicModelRefs | null {
  const parsed = parseAnthropicModelRef(raw);
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

/** Resolve a known Anthropic/Claude CLI model ref to its current Anthropic model ref. */
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
