// Ollama provider module implements model/runtime integration.
import type {
  ModelProviderConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

/** Provider config input type — partial config without required `models`. */
type OllamaProviderConfigInput = Omit<Partial<ModelProviderConfig>, "models"> & {
  models?: ModelDefinitionConfig[];
};

export function readProviderBaseUrl(
  provider: OllamaProviderConfigInput | undefined,
): string | undefined {
  if (!provider) {
    return undefined;
  }
  if (
    Object.hasOwn(provider, "baseUrl") &&
    typeof provider.baseUrl === "string" &&
    provider.baseUrl.trim()
  ) {
    return provider.baseUrl.trim();
  }
  const alternate = provider as OllamaProviderConfigInput & { baseURL?: unknown };
  if (
    Object.hasOwn(alternate, "baseURL") &&
    typeof alternate.baseURL === "string" &&
    alternate.baseURL.trim()
  ) {
    return alternate.baseURL.trim();
  }
  return undefined;
}
