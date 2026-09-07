import "./cli-auth-epoch.js";

type CliAuthEpochDeps = {
  readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
  readGeminiCliCredentialsCached: typeof import("./cli-credentials.js").readGeminiCliCredentialsCached;
  ensureAuthProfileStore: typeof import("./auth-profiles/store-runtime.js").ensureAuthProfileStore;
  loadAuthProfileStoreForRuntime: typeof import("./auth-profiles/store-runtime.js").loadAuthProfileStoreForRuntime;
};

type CliAuthEpochTestApi = {
  setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void;
  resetCliAuthEpochTestDeps(): void;
};

function getTestApi(): CliAuthEpochTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliAuthEpochTestApi")
  ] as CliAuthEpochTestApi;
}

export const setCliAuthEpochTestDeps = (overrides: Partial<CliAuthEpochDeps>): void =>
  getTestApi().setCliAuthEpochTestDeps(overrides);

export const resetCliAuthEpochTestDeps = (): void => getTestApi().resetCliAuthEpochTestDeps();
