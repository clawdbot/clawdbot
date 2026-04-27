import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export function readProviderBaseUrl(provider: ModelProviderConfig | undefined): string | undefined {
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
  const alternate = provider as ModelProviderConfig & { baseURL?: unknown };
  if (
    Object.hasOwn(alternate, "baseURL") &&
    typeof alternate.baseURL === "string" &&
    alternate.baseURL.trim()
  ) {
    return alternate.baseURL.trim();
  }
  return undefined;
}
