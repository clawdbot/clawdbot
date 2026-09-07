type PreparedModelRuntimeTestApi = {
  resetPreparedModelRuntimeSnapshotsForTest(): Promise<void>;
};

/** Clears prepared model owners when the production module is loaded in this test worker. */
export async function resetPreparedModelRuntimeSnapshotsForTest(): Promise<void> {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as PreparedModelRuntimeTestApi | undefined;
  await api?.resetPreparedModelRuntimeSnapshotsForTest();
}
