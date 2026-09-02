import "./store.js";

type AuthProfileStoreTestApi = {
  resetRuntimeSnapshotPublisherForTest(): void;
  setRuntimeSnapshotPublisherForTest(publisher: (publish: () => void) => void): void;
};

function getTestApi(): AuthProfileStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.authProfileStoreTestApi")
  ] as AuthProfileStoreTestApi;
}

export const testing: AuthProfileStoreTestApi = {
  resetRuntimeSnapshotPublisherForTest: () => getTestApi().resetRuntimeSnapshotPublisherForTest(),
  setRuntimeSnapshotPublisherForTest: (publisher) =>
    getTestApi().setRuntimeSnapshotPublisherForTest(publisher),
};
