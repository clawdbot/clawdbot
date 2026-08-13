import "./provider-auth-aliases.js";

type ProviderAuthAliasesTestApi = {
  resetProviderAuthAliasMapCacheForTest(): void;
};

function getTestApi(): ProviderAuthAliasesTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.providerAuthAliasesTestApi")
  ];
  if (!api) {
    throw new Error("provider auth aliases test API is unavailable");
  }
  return api as ProviderAuthAliasesTestApi;
}

export function resetProviderAuthAliasMapCacheForTest(): void {
  getTestApi().resetProviderAuthAliasMapCacheForTest();
}
