import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { normalizeAgentModelRefForConfig } from "../../../config/model-input.js";

export function hasOwnDefinedProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function preferredClaudeSeparator(provider: string | undefined): "." | "-" {
  return provider === "github-copilot" || provider === "copilot-proxy" ? "." : "-";
}

function claudeTargetModelId(
  family: "opus" | "sonnet",
  separator: "." | "-",
  provider?: string,
): string {
  const version =
    family === "opus" && provider !== "venice" && provider !== "vercel-ai-gateway" ? "4.7" : "4.6";
  return `claude-${family}-${separator === "." ? version : version.replace(".", "-")}`;
}

function shouldUpgradeClaudeProvider(provider: string | undefined): boolean {
  return (
    !provider ||
    provider === "anthropic" ||
    provider === "github-copilot" ||
    provider === "copilot-proxy" ||
    provider === "venice" ||
    provider === "vercel-ai-gateway"
  );
}

function modelTable(groups: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(groups).flatMap(([target, models]) =>
      models.split(" ").map((model) => [model, target]),
    ),
  );
}

const RETIRED_GROQ_MODELS = modelTable({
  "llama-3.3-70b-versatile": "deepseek-r1-distill-llama-70b llama3-70b-8192",
  "llama-3.1-8b-instant": "gemma2-9b-it llama3-8b-8192",
  "openai/gpt-oss-120b":
    "meta-llama/llama-4-maverick-17b-128e-instruct moonshotai/kimi-k2-instruct moonshotai/kimi-k2-instruct-0905",
  "qwen/qwen3-32b": "mistral-saba-24b qwen-qwq-32b",
});
const RETIRED_XAI_MODELS = modelTable({
  "grok-build-0.1": "grok-code-fast grok-code-fast-1 grok-code-fast-1-0825",
  "grok-4.3": "grok-4-fast-reasoning grok-4-1-fast-reasoning grok-4-0709",
  "grok-imagine-image-quality": "grok-imagine-image-pro",
});
const RETIRED_OPENAI_MODELS = modelTable({
  "gpt-5.3-codex": "gpt-5.2-codex gpt-5.1-codex gpt-5-codex",
  "gpt-5.5-pro": "gpt-5-pro gpt-5.2-pro",
  "gpt-5.4-nano": "gpt-4.1-nano gpt-5-nano",
  "gpt-5.4-mini": "gpt-4.1-mini gpt-4o-mini gpt-5.1-codex-mini gpt-5-mini",
  "gpt-5.5":
    "gpt-4 gpt-4-turbo gpt-4.1 gpt-4o gpt-4o-2024-05-13 gpt-4o-2024-08-06 gpt-4o-2024-11-20 gpt-5 gpt-5-chat-latest gpt-5.1 gpt-5.1-chat-latest gpt-5.1-codex-max gpt-5.2 gpt-5.2-chat-latest",
});
const RETIRED_CODEX_MODEL_OVERRIDES = modelTable({
  "gpt-5.5": "gpt-5.2 gpt-5.2-codex gpt-5.1-codex gpt-5-codex",
  "gpt-5.4-mini": "gpt-4.1-nano gpt-5-nano",
});

function applyRetiredModelTable(
  normalizedModel: string,
  table: Readonly<Record<string, string>>,
  overrides?: Readonly<Record<string, string>>,
): string | null {
  if (overrides && Object.hasOwn(overrides, normalizedModel)) {
    return overrides[normalizedModel] ?? null;
  }
  return Object.hasOwn(table, normalizedModel) ? (table[normalizedModel] ?? null) : null;
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

const RETIRED_OPUS_ALIASES = new Set("opus-4.5 opus-4.1 opus-4 opus-3".split(" "));
const RETIRED_SONNET_ALIASES = new Set(
  "sonnet-4.5 sonnet-4.1 sonnet-4.0 sonnet-4 sonnet-3.7 sonnet-3.5 sonnet-3 haiku-3.5 haiku-3".split(
    " ",
  ),
);

function upgradeOldClaudeToken(
  token: string,
  separator: "." | "-",
  provider?: string,
): string | null {
  const normalized = normalizeString(token);
  if (!normalized) {
    return null;
  }
  const opusTarget = claudeTargetModelId("opus", separator, provider);
  const sonnetTarget = claudeTargetModelId("sonnet", separator, provider);
  if (
    normalized.startsWith("claude-opus-4-7") ||
    normalized.startsWith("claude-opus-4.7") ||
    normalized.startsWith("claude-opus-4-6") ||
    normalized.startsWith("claude-opus-4.6") ||
    normalized.startsWith("claude-sonnet-4-6") ||
    normalized.startsWith("claude-sonnet-4.6")
  ) {
    return null;
  }
  // claude-haiku-4-5 is a current production model and must not be migrated.
  if (normalized.startsWith("claude-haiku-4-5") || normalized.startsWith("claude-haiku-4.5")) {
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
    return opusTarget;
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
    return sonnetTarget;
  }
  if (normalized.startsWith("claude-3") && normalized.includes("opus")) {
    return opusTarget;
  }
  if (
    normalized.startsWith("claude-3") &&
    (normalized.includes("sonnet") || normalized.includes("haiku"))
  ) {
    return sonnetTarget;
  }
  if (normalized.startsWith("anthropic.claude-opus-")) {
    if (provider === "amazon-bedrock" || provider === "amazon-bedrock-mantle") {
      return null;
    }
    if (
      normalized.startsWith("anthropic.claude-opus-4-7") ||
      normalized.startsWith("anthropic.claude-opus-4-6")
    ) {
      return null;
    }
    return `anthropic.${claudeTargetModelId("opus", "-", provider)}`;
  }
  if (
    normalized.startsWith("anthropic.claude-sonnet-") ||
    normalized.startsWith("anthropic.claude-haiku-")
  ) {
    if (provider === "amazon-bedrock" || provider === "amazon-bedrock-mantle") {
      return null;
    }
    if (normalized.startsWith("anthropic.claude-sonnet-4-6")) {
      return null;
    }
    return `anthropic.${claudeTargetModelId("sonnet", "-", provider)}`;
  }
  if (RETIRED_OPUS_ALIASES.has(normalized)) {
    return opusTarget;
  }
  if (RETIRED_SONNET_ALIASES.has(normalized)) {
    return sonnetTarget;
  }
  return null;
}

function upgradeOldClaudeModelPart(model: string, provider: string | undefined): string | null {
  const separator = preferredClaudeSeparator(provider);
  const slashParts = model.split("/");
  const lastPart = slashParts.at(-1);
  if (lastPart) {
    const upgraded = upgradeOldClaudeToken(lastPart, separator, provider);
    if (upgraded) {
      return [...slashParts.slice(0, -1), upgraded].join("/");
    }
  }
  return upgradeOldClaudeToken(model, separator, provider);
}

function canonicalizeKnownModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const split = splitTrailingAuthProfile(trimmed);
  const modelRef = split.model;
  const slash = modelRef.indexOf("/");
  const provider = slash > 0 ? modelRef.slice(0, slash).trim() : undefined;
  const model = slash > 0 ? modelRef.slice(slash + 1).trim() : modelRef;
  const normalizedProvider = normalizeString(provider);
  const normalizedModel = normalizeString(model);
  if (normalizedProvider === "openai" && normalizedModel === "gpt-5.6") {
    return `${provider}/gpt-5.6-sol${split.profile ? `@${split.profile}` : ""}`;
  }
  const retiredOwnerModel =
    normalizedProvider === "groq"
      ? applyRetiredModelTable(normalizedModel, RETIRED_GROQ_MODELS)
      : normalizedProvider === "xai"
        ? applyRetiredModelTable(normalizedModel, RETIRED_XAI_MODELS)
        : normalizedProvider === "openai" ||
            normalizedProvider === "openai-codex" ||
            normalizedProvider === "github-copilot"
          ? applyRetiredModelTable(
              normalizedModel,
              RETIRED_OPENAI_MODELS,
              normalizedProvider === "openai-codex" ? RETIRED_CODEX_MODEL_OVERRIDES : undefined,
            )
          : undefined;
  if (retiredOwnerModel) {
    return `${provider}/${retiredOwnerModel}${split.profile ? `@${split.profile}` : ""}`;
  }
  if (
    (normalizedProvider === "github-copilot" || normalizedProvider === "copilot-proxy") &&
    normalizedModel === "grok-code-fast-1"
  ) {
    return `${provider}/gpt-5.4-mini${split.profile ? `@${split.profile}` : ""}`;
  }
  if (!shouldUpgradeClaudeProvider(normalizedProvider || undefined)) {
    return null;
  }
  const upgradedModel = upgradeOldClaudeModelPart(model, normalizedProvider || undefined);
  if (!upgradedModel || upgradedModel === model) {
    return null;
  }
  const upgraded = provider ? `${provider}/${upgradedModel}` : upgradedModel;
  return `${upgraded}${split.profile ? `@${split.profile}` : ""}`;
}

export function normalizeKnownModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return value === trimmed ? null : trimmed;
  }
  const split = splitTrailingAuthProfile(trimmed);
  const slash = split.model.indexOf("/");
  const provider = slash > 0 ? normalizeString(split.model.slice(0, slash)) : "";
  const modelId = slash > 0 ? split.model.slice(slash + 1) : split.model;
  const normalizedModel =
    provider === "google" ||
    provider === "google-gemini-cli" ||
    provider === "google-vertex" ||
    provider === "together" ||
    normalizeString(modelId).startsWith("google/")
      ? normalizeAgentModelRefForConfig(split.model)
      : split.model;
  const normalized = `${normalizedModel}${split.profile ? `@${split.profile}` : ""}`;
  return canonicalizeKnownModelRef(normalized) ?? (normalized === value ? null : normalized);
}

export const MODEL_REF_STRING_KEYS = new Set([
  "model",
  "primary",
  "summaryModel",
  "imageModel",
  "utilityModel",
  "voiceModel",
  "imageGenerationModel",
  "musicGenerationModel",
  "pdfModel",
  "videoGenerationModel",
  "preferredModel",
]);
export const MODEL_REF_ARRAY_KEYS = new Set([
  "fallback",
  "fallbacks",
  "allowedModels",
  "modelFallbacks",
  "imageModelFallbacks",
]);
export const MODEL_REF_MAP_KEYS = new Set(["models"]);

export function normalizeProviderCatalogModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  const normalizedProvider = normalizeString(provider);
  const normalized =
    normalizedProvider === "google" ||
    normalizedProvider === "google-gemini-cli" ||
    normalizedProvider === "google-vertex" ||
    normalizedProvider === "together" ||
    normalizeString(trimmed).startsWith("google/")
      ? normalizeConfiguredProviderCatalogModelId(provider, trimmed)
      : trimmed;
  const upgradedRef = canonicalizeKnownModelRef(`${provider}/${normalized}`);
  if (!upgradedRef) {
    return normalized;
  }
  const slash = upgradedRef.indexOf("/");
  return slash > 0 && normalizeString(upgradedRef.slice(0, slash)) === normalizeString(provider)
    ? upgradedRef.slice(slash + 1)
    : normalized;
}
