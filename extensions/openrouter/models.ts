// Openrouter plugin module implements models behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const OPENROUTER_MISTRAL_MODEL_PREFIXES = [
  "mistralai/",
  "mistral/",
  "mistral-",
  "codestral-",
  "devstral-",
  "ministral-",
  "mixtral-",
  "pixtral-",
  "voxtral-",
] as const;
const OPENROUTER_MODEL_PREFIX = "openrouter/";

// Short OpenRouter model refs surfaced by OpenClaw (e.g. `models list`) that are
// not native OpenRouter routes. The upstream API expects the namespaced slug.
const OPENROUTER_SHORT_TO_API_MODEL_ID = new Map([
  ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
  ["deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
]);

export function normalizeOpenRouterModelFamilyId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.replace(/^openrouter\//, "").replace(/^~/, "");
}

export function normalizeOpenRouterApiModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized.startsWith(OPENROUTER_MODEL_PREFIX)) {
    return normalized;
  }
  const unprefixed = normalized.slice(OPENROUTER_MODEL_PREFIX.length);
  const shortExpanded = OPENROUTER_SHORT_TO_API_MODEL_ID.get(unprefixed);
  if (shortExpanded) {
    return shortExpanded;
  }
  // `openrouter/` is both a provider qualifier and an upstream namespace.
  // Strip it only when the remainder is still a namespaced API model id.
  return unprefixed.includes("/") ? unprefixed : normalized;
}

export function isOpenRouterMistralModelId(modelId: unknown): boolean {
  const normalized = normalizeOpenRouterModelFamilyId(modelId);
  return Boolean(
    normalized && OPENROUTER_MISTRAL_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix)),
  );
}

export function isOpenRouterDeepSeekV4ModelId(modelId: unknown): boolean {
  return /^deepseek\/deepseek-v4-(?:flash|pro)(?:-\d{4,8})?(?::[^/]*)?$/.test(
    normalizeOpenRouterModelFamilyId(modelId) ?? "",
  );
}
