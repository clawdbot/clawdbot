/**
 * OpenAI reasoning-effort compatibility helpers.
 *
 * Keeps provider metadata and built-in model exceptions on one path before request payloads are built.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Minimal model fields needed to resolve OpenAI reasoning effort compatibility. */
type OpenAIReasoningCompatModel = {
  provider?: string | null;
  id?: string | null;
  compat?: unknown;
};

// These OpenAI models reject minimal/low reasoning but accept medium. Map lower
// efforts up unless provider metadata supplies a more specific compat map.
const OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS = new Set(["gpt-5.1-codex-mini"]);

// Provider metadata can remap reasoning effort names. Keep only string pairs so
// malformed compat data cannot poison request parameters.
function readCompatReasoningEffortMap(compat: unknown): Record<string, string> {
  if (!compat || typeof compat !== "object") {
    return {};
  }
  const rawMap = (compat as { reasoningEffortMap?: unknown }).reasoningEffortMap;
  if (!rawMap || typeof rawMap !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawMap).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

/** Resolves the reasoning effort remap for an OpenAI-compatible model. */
export function resolveOpenAIReasoningEffortMap(
  model: OpenAIReasoningCompatModel,
  fallbackMap: Record<string, string> = {},
): Record<string, string> {
  const provider = normalizeLowercaseStringOrEmpty(model.provider ?? "");
  const id = normalizeLowercaseStringOrEmpty(model.id ?? "");
  const builtinMap: Record<string, string> =
    provider === "openai" && OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS.has(id)
      ? { minimal: "medium", low: "medium" }
      : {};
  return {
    ...fallbackMap,
    ...builtinMap,
    ...readCompatReasoningEffortMap(model.compat),
  };
}
