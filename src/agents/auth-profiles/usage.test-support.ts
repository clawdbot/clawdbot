import "./usage.js";

type UsageDeps = {
  updateAuthProfileStoreWithLock: typeof import("./store.js").updateAuthProfileStoreWithLock;
};

type AuthProfileUsageTestApi = {
  setDepsForTest(overrides: Partial<UsageDeps> | null): void;
  resetWhamReprobeStateForTest(): void;
};

function getTestApi(): AuthProfileUsageTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.authProfileUsageTestApi")
  ] as AuthProfileUsageTestApi;
}

export const testing: AuthProfileUsageTestApi = {
  setDepsForTest: (overrides) => getTestApi().setDepsForTest(overrides),
  resetWhamReprobeStateForTest: () => getTestApi().resetWhamReprobeStateForTest(),
};
