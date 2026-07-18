/**
 * Claude CLI model-ref normalization. It maps family aliases and retired model
 * ids to current Anthropic runtime refs while preserving auth-profile suffixes.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_MODEL_ALIASES } from "./cli-constants.js";

const DEFAULT_CLAUDE_MODEL_BY_FAMILY: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  fable: "claude-fable-5",
  haiku: "claude-haiku-4-5",
};

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
  const defaultModel = DEFAULT_CLAUDE_MODEL_BY_FAMILY[normalized];
  if (defaultModel) {
    return attachModelAuthProfile(defaultModel, split.profile);
  }
  const aliasedModel = CLAUDE_CLI_MODEL_ALIASES[normalized];
  return aliasedModel?.startsWith("claude-")
    ? attachModelAuthProfile(aliasedModel, split.profile)
    : null;
}

function upgradeOldClaudeModelId(normalized: string): string | null {
  if (normalized.startsWith("claude-opus-4-8") || normalized.startsWith("claude-opus-4.8")) {
    return null;
  }
  if (normalized.startsWith("claude-opus-4-7") || normalized.startsWith("claude-opus-4.7")) {
    return null;
  }
  if (normalized.startsWith("claude-opus-4-6") || normalized.startsWith("claude-opus-4.6")) {
    return null;
  }
  if (normalized.startsWith("claude-sonnet-4-6") || normalized.startsWith("claude-sonnet-4.6")) {
    return null;
  }
  // claude-haiku-4-5 is a current production model and must not be migrated.
  if (normalized.startsWith("claude-haiku-4-5") || normalized.startsWith("claude-haiku-4.5")) {
    return null;
  }
  if (
    normalized === "claude-opus-4" ||
    hasAnyRetiredVersionPrefix(normalized, [
      "claude-opus-4-7",
      "claude-opus-4.7",
      "claude-opus-4-5",
      "claude-opus-4.5",
      "claude-opus-4-1",
      "claude-opus-4.1",
      "claude-opus-4-0",
      "claude-opus-4.0",
    ]) ||
    /^claude-opus-4-20\d{6}/.test(normalized)
  ) {
    return "claude-opus-4-8";
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
    return "claude-opus-4-8";
  }
  if (
    normalized.startsWith("claude-3") &&
    (normalized.includes("sonnet") || normalized.includes("haiku"))
  ) {
    return "claude-sonnet-4-6";
  }
  if (
    normalized === "opus-4.5" ||
    normalized === "opus-4.1" ||
    normalized === "opus-4" ||
    normalized === "opus-3"
  ) {
    return "claude-opus-4-8";
  }
  if (
    normalized === "sonnet-4.5" ||
    normalized === "sonnet-4.1" ||
    normalized === "sonnet-4.0" ||
    normalized === "sonnet-4" ||
    normalized === "sonnet-3.7" ||
    normalized === "sonnet-3.5" ||
    normalized === "sonnet-3" ||
    normalized === "haiku-3.5" ||
    normalized === "haiku-3"
  ) {
    return "claude-sonnet-4-6";
  }
  return null;
}

/** Resolve a Claude CLI model ref into selected and Anthropic-compatible runtime refs. */
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
