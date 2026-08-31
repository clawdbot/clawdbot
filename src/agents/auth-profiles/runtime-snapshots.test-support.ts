import "./runtime-snapshots.js";

type RuntimeSnapshotsTestApi = {
  MAX_PERSISTED_MUTATION_OWNERS: number;
  MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER: number;
  getPersistedMutationRecordCounts(): { owners: number; profiles: number };
  resetPersistedMutationLineage(): void;
};

function getTestApi(): RuntimeSnapshotsTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.runtimeAuthSnapshotsTestApi")
  ] as RuntimeSnapshotsTestApi;
}

export const testing: RuntimeSnapshotsTestApi = {
  get MAX_PERSISTED_MUTATION_OWNERS() {
    return getTestApi().MAX_PERSISTED_MUTATION_OWNERS;
  },
  get MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER() {
    return getTestApi().MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER;
  },
  getPersistedMutationRecordCounts: () => getTestApi().getPersistedMutationRecordCounts(),
  resetPersistedMutationLineage: () => getTestApi().resetPersistedMutationLineage(),
};
