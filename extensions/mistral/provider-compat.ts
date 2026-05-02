import { resolveProviderRequestCapabilities } from "openclaw/plugin-sdk/provider-http";
import { normalizeLowercaseStringOrEmpty, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { MISTRAL_MODEL_TRANSPORT_PATCH } from "./api.js";

const MISTRAL_MODEL_HINTS = [
  "mistral",
  "mistralai",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
] as const;

function isMistralModelHint(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return MISTRAL_MODEL_HINTS.some(
    (hint) =>
      normalized === hint ||
      normalized.startsWith(`${hint}/`) ||
      normalized.startsWith(`${hint}-`) ||
      normalized.startsWith(`${hint}:`),
  );
}

function shouldContributeMistralCompat(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown; provider?: unknown; compat?: unknown };
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }

  const capabilities = resolveProviderRequestCapabilities({
    provider: readStringValue(params.model.provider),
    api: "openai-completions",
    baseUrl: readStringValue(params.model.baseUrl),
    capability: "llm",
    transport: "stream",
    modelId: params.modelId,
    compat:
      params.model.compat && typeof params.model.compat === "object"
        ? (params.model.compat as { supportsStore?: boolean })
        : undefined,
  });

  return (
    capabilities.knownProviderFamily === "mistral" ||
    capabilities.endpointClass === "mistral-public" ||
    isMistralModelHint(params.modelId)
  );
}

export function contributeMistralResolvedModelCompat(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown; provider?: unknown; compat?: unknown };
}) {
  return shouldContributeMistralCompat(params) ? MISTRAL_MODEL_TRANSPORT_PATCH : undefined;
}
