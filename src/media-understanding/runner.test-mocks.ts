import { vi } from "vitest";

export function createAvailableModelAuthMockModule() {
  return {
    hasAvailableAuthForProvider: vi.fn(() => true),
    resolveApiKeyForProvider: vi.fn(async () => ({
      apiKey: "test-key",
      source: "test",
      mode: "api-key",
    })),
    requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
  };
}

export function createEmptyCapabilityProviderMockModule() {
  return {
    resolvePluginCapabilityProviders: () => [],
  };
}
