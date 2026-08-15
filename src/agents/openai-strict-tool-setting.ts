/**
 * Strict tool-schema default resolution for native OpenAI-compatible routes.
 *
 * Compatible providers can support strict schemas without inheriting OpenAI's required default.
 */
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

// Resolves OpenAI strict-tool schema defaults. Native OpenAI routes require
// strict=true, while compatible providers that merely support strict mode get
// false so callers can opt in without forcing provider-specific behavior.
type OpenAITransportKind = "stream" | "websocket";

type OpenAIStrictToolModel = {
  provider?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  compat?: unknown;
};

function resolvesToNativeOpenAIStrictTools(
  model: OpenAIStrictToolModel,
  transport: OpenAITransportKind,
): boolean {
  const capabilities = resolveProviderRequestCapabilities({
    provider: readStringValue(model.provider),
    api: readStringValue(model.api),
    baseUrl: readStringValue(model.baseUrl),
    capability: "llm",
    transport,
    modelId: readStringValue(model.id),
    compat: model.compat,
  });
  if (!capabilities.usesKnownNativeOpenAIRoute) {
    return false;
  }
  return (
    capabilities.provider === "openai" ||
    capabilities.provider === "azure-openai" ||
    capabilities.provider === "azure-openai-responses"
  );
}

/** Resolve the strict-tool setting for one OpenAI-compatible model/transport. */
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
