import { readStringValue } from "../shared/string-coerce.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

type OpenAITransportKind = "stream" | "websocket";

type OpenAIStrictToolModel = {
  provider?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  compat?: { supportsStore?: boolean };
};

const optionalString = readStringValue;

export function resolvesToNativeOpenAIStrictTools(
  model: OpenAIStrictToolModel,
  transport: OpenAITransportKind,
): boolean {
  const capabilities = resolveProviderRequestCapabilities({
    provider: optionalString(model.provider),
    api: optionalString(model.api),
    baseUrl: optionalString(model.baseUrl),
    capability: "llm",
    transport,
    modelId: optionalString(model.id),
    compat:
      model.compat && typeof model.compat === "object"
        ? (model.compat as { supportsStore?: boolean })
        : undefined,
  });
  if (!capabilities.usesKnownNativeOpenAIRoute) {
    return false;
  }
  return (
    capabilities.provider === "openai" ||
    capabilities.provider === "openai-codex" ||
    capabilities.provider === "azure-openai" ||
    capabilities.provider === "azure-openai-responses"
  );
}

export function resolveOpenAIStrictToolSetting(
  model: OpenAIStrictToolModel,
  options?: { transport?: OpenAITransportKind; supportsStrictMode?: boolean },
): boolean | undefined {
  if (resolvesToNativeOpenAIStrictTools(model, options?.transport ?? "stream")) {
    return true;
  }
  if (options?.supportsStrictMode) {
    return false;
  }
  return undefined;
}
