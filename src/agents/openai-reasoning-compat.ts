import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type OpenAIReasoningCompatModel = {
  provider?: string | null;
  id?: string | null;
  compat?: unknown;
};

const OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS = new Set(["gpt-5.1-codex-mini"]);

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
