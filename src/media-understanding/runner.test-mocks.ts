import { vi } from "vitest";

export function createAvailableModelAuthMockModule() {
  class ProviderAuthError extends Error {
    constructor(
      readonly code: "missing-api-key" | "missing-provider-auth",
      readonly provider: string,
      message: string,
    ) {
      super(message);
      this.name = "ProviderAuthError";
    }
  }

  return {
    hasAvailableAuthForProvider: vi.fn(() => true),
    resolveApiKeyForProvider: vi.fn(async () => ({
      apiKey: "test-key",
      source: "test",
      mode: "api-key",
    })),
    ProviderAuthError,
    isProviderAuthError: vi.fn(
      (err: unknown, code?: "missing-api-key" | "missing-provider-auth") =>
        err instanceof ProviderAuthError && (!code || err.code === code),
    ),
    requireApiKey: vi.fn((auth: { apiKey?: string }, provider: string) => {
      if (auth.apiKey) {
        return auth.apiKey;
      }
      throw new ProviderAuthError(
        "missing-api-key",
        provider,
        `No API key resolved for provider "${provider}".`,
      );
    }),
  };
}

export function createEmptyCapabilityProviderMockModule() {
  return {
    resolvePluginCapabilityProviders: () => [],
  };
}
