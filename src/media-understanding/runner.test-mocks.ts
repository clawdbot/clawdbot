// Shared media runner mock factories provide model-auth and plugin-capability
// modules for isolated runner tests.
import { vi } from "vitest";

/** Builds the auth resolver mock module used by media runner tests. */
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

  // Keep the mock shape aligned with available-model-auth runtime imports.
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

/** Builds a plugin capability provider mock with no runtime providers. */
export function createEmptyCapabilityProviderMockModule() {
  return {
    resolvePluginCapabilityProviders: () => [],
  };
}
