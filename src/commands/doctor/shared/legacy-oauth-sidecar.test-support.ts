import "./legacy-oauth-sidecar.js";

type TestApi = { resetKeychainOnlyMigrationHint(): void };

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.legacyOAuthSidecarInternalTestApi")
  ] as TestApi;
}

export const legacyOAuthSidecarInternalTestUtils: TestApi = {
  resetKeychainOnlyMigrationHint(): void {
    getTestApi().resetKeychainOnlyMigrationHint();
  },
};
