import path from "node:path";
/**
 * Process-local auth profile snapshots used by prepared runtimes and tests.
 * Snapshots are cloned at boundaries so callers cannot mutate shared state.
 */
import { isDeepStrictEqual } from "node:util";
import { cloneAuthProfileStore } from "./clone.js";
import { resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

const runtimeAuthStoreSnapshots = new Map<string, RuntimeAuthProfileStore>();
let runtimeAuthStoreCredentialsRevision = 0;
let runtimeAuthStoreSnapshotsRevision = 0;
// Per-store generations isolate rollback ownership; the global counter remains
// the deletion generation for keys no longer present in this map.
const runtimeAuthStoreSnapshotRevisions = new Map<string, number>();
let persistedMutationRevision = 0;
let evictedOwnerMutationFloor = 0;
const MAX_PERSISTED_MUTATION_OWNERS = 256;
const MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER = 256;

type PersistedMutationRecord = {
  credentialRevision: number;
  credentialRevisionKnown: boolean;
  profileSetRevision: number;
  profileSetRevisionKnown: boolean;
  stateRevision: number;
  stateRevisionKnown: boolean;
  mutationFloor: number;
  profileRevisions: Map<string, number>;
};

const persistedMutationRecords = new Map<string, PersistedMutationRecord>();

function maxMutationRevision(record: PersistedMutationRecord): number {
  return Math.max(
    record.credentialRevision,
    record.profileSetRevision,
    record.stateRevision,
    record.mutationFloor,
    ...record.profileRevisions.values(),
  );
}

function getOrCreatePersistedMutationRecord(ownerKey: string): PersistedMutationRecord {
  const existing = persistedMutationRecords.get(ownerKey);
  if (existing) {
    // Mutations, rather than reads, drive LRU recency so observation cannot
    // retain dormant owners forever.
    persistedMutationRecords.delete(ownerKey);
    persistedMutationRecords.set(ownerKey, existing);
    return existing;
  }
  const record: PersistedMutationRecord = {
    credentialRevision: evictedOwnerMutationFloor,
    credentialRevisionKnown: evictedOwnerMutationFloor === 0,
    profileSetRevision: evictedOwnerMutationFloor,
    profileSetRevisionKnown: evictedOwnerMutationFloor === 0,
    stateRevision: evictedOwnerMutationFloor,
    stateRevisionKnown: evictedOwnerMutationFloor === 0,
    mutationFloor: evictedOwnerMutationFloor,
    profileRevisions: new Map(),
  };
  persistedMutationRecords.set(ownerKey, record);
  while (persistedMutationRecords.size > MAX_PERSISTED_MUTATION_OWNERS) {
    const oldestOwnerKey = persistedMutationRecords.keys().next().value;
    if (oldestOwnerKey === undefined) {
      break;
    }
    const oldest = persistedMutationRecords.get(oldestOwnerKey);
    persistedMutationRecords.delete(oldestOwnerKey);
    if (oldest) {
      // A floor trades false-positive rollback fences for bounded memory; it
      // must never let an evicted persisted mutation look unchanged.
      evictedOwnerMutationFloor = Math.max(evictedOwnerMutationFloor, maxMutationRevision(oldest));
    }
  }
  record.mutationFloor = Math.max(record.mutationFloor, evictedOwnerMutationFloor);
  return record;
}

function setProfileMutationRevision(
  record: PersistedMutationRecord,
  profileId: string,
  revision: number,
): void {
  record.profileRevisions.delete(profileId);
  record.profileRevisions.set(profileId, revision);
  while (record.profileRevisions.size > MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER) {
    const oldestProfileId = record.profileRevisions.keys().next().value;
    if (oldestProfileId === undefined) {
      break;
    }
    const oldestRevision = record.profileRevisions.get(oldestProfileId) ?? 0;
    record.profileRevisions.delete(oldestProfileId);
    record.mutationFloor = Math.max(record.mutationFloor, oldestRevision);
  }
}

function getPersistedMutationRecord(ownerKey: string): PersistedMutationRecord | undefined {
  return persistedMutationRecords.get(ownerKey);
}

function credentialState(
  entries: Iterable<[string, RuntimeAuthProfileStore]>,
): Array<readonly [string, AuthProfileStore["profiles"]]> {
  return Array.from(entries)
    .filter(([, store]) => Object.keys(store.profiles).length > 0)
    .map(([key, store]) => [key, store.profiles] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function replaceChangesCredentials(
  entries: Array<{ agentDir?: string; store: RuntimeAuthProfileStore }>,
): boolean {
  const next = new Map(
    entries.map((entry) => [resolveRuntimeStoreKey(entry.agentDir), entry.store] as const),
  );
  return !isDeepStrictEqual(credentialState(runtimeAuthStoreSnapshots), credentialState(next));
}

function recordChangedSnapshotRevisions(
  entries: Array<{ agentDir?: string; store: RuntimeAuthProfileStore }>,
): void {
  const next = new Map(
    entries.map((entry) => [resolveRuntimeStoreKey(entry.agentDir), entry.store] as const),
  );
  const keys = new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]);
  for (const key of keys) {
    if (isDeepStrictEqual(runtimeAuthStoreSnapshots.get(key), next.get(key))) {
      continue;
    }
    runtimeAuthStoreSnapshotsRevision += 1;
    if (next.has(key)) {
      runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
    } else {
      runtimeAuthStoreSnapshotRevisions.delete(key);
    }
  }
}

// Runtime snapshots are keyed by the resolved auth store path so default-agent
// and per-agent stores do not overwrite each other.
function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

/** Reads a cloned runtime auth profile store snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): RuntimeAuthProfileStore | undefined {
  const store = runtimeAuthStoreSnapshots.get(resolveRuntimeStoreKey(agentDir));
  return store ? cloneAuthProfileStore(store) : undefined;
}

/** Lists cloned live snapshots for transactional rollback composition. */
export function listRuntimeAuthProfileStoreSnapshots(): Array<{
  agentDir: string;
  store: RuntimeAuthProfileStore;
}> {
  return Array.from(runtimeAuthStoreSnapshots, ([key, store]) => ({
    agentDir: path.dirname(key),
    store: cloneAuthProfileStore(store),
  }));
}

/** Returns true when a runtime snapshot exists for an agent dir. */
export function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return runtimeAuthStoreSnapshots.has(resolveRuntimeStoreKey(agentDir));
}

/** Returns true when requested or main runtime snapshots contain profiles. */
export function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (requestedStore && Object.keys(requestedStore.profiles).length > 0) {
    return true;
  }
  if (!agentDir) {
    return false;
  }
  const mainStore = getRuntimeAuthProfileStoreSnapshot();
  return Boolean(mainStore && Object.keys(mainStore.profiles).length > 0);
}

/** Replaces all runtime auth profile snapshots with cloned entries. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: RuntimeAuthProfileStore }>,
): void {
  if (replaceChangesCredentials(entries)) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  recordChangedSnapshotRevisions(entries);
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

/** Clears all runtime auth profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  if (credentialState(runtimeAuthStoreSnapshots).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  if (runtimeAuthStoreSnapshots.size > 0) {
    runtimeAuthStoreSnapshotsRevision += 1;
  }
  runtimeAuthStoreSnapshots.clear();
  runtimeAuthStoreSnapshotRevisions.clear();
}

/** Clears one runtime auth-profile snapshot without disturbing other active agents. */
export function clearRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  const key = resolveRuntimeStoreKey(agentDir);
  const store = runtimeAuthStoreSnapshots.get(key);
  if (!store) {
    return false;
  }
  if (Object.keys(store.profiles).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthStoreSnapshotsRevision += 1;
  runtimeAuthStoreSnapshots.delete(key);
  runtimeAuthStoreSnapshotRevisions.delete(key);
  return true;
}

/** Stores a cloned runtime auth profile snapshot for an agent dir. */
export function setRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  const key = resolveRuntimeStoreKey(agentDir);
  if (!isDeepStrictEqual(runtimeAuthStoreSnapshots.get(key)?.profiles ?? {}, store.profiles)) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  if (!isDeepStrictEqual(runtimeAuthStoreSnapshots.get(key), store)) {
    runtimeAuthStoreSnapshotsRevision += 1;
    runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
  }
  runtimeAuthStoreSnapshots.set(key, cloneAuthProfileStore(store));
}

/**
 * Invalidates prepared credential ownership after a persisted owner-store write.
 * Main-store credentials are inherited by custom-agent snapshots, so those
 * derived snapshots must be dropped even when no exact main snapshot exists.
 * State-only saves refresh them in the publisher without changing credential ownership.
 */
export function noteRuntimeAuthProfileStorePersistedMutation(
  agentDir: string | undefined,
  mutation: {
    credentialsChanged: boolean;
    profileSetChanged?: boolean;
    stateChanged: boolean;
    profileIds: Iterable<string>;
  },
): void {
  if (!mutation.credentialsChanged && !mutation.profileSetChanged && !mutation.stateChanged) {
    return;
  }
  persistedMutationRevision += 1;
  if (mutation.credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const ownerKey = resolveRuntimeStoreKey(agentDir);
  const record = getOrCreatePersistedMutationRecord(ownerKey);
  if (mutation.profileSetChanged) {
    record.profileSetRevision = persistedMutationRevision;
    record.profileSetRevisionKnown = true;
  }
  if (mutation.credentialsChanged) {
    record.credentialRevision = persistedMutationRevision;
    record.credentialRevisionKnown = true;
    for (const profileId of mutation.profileIds) {
      setProfileMutationRevision(record, profileId, persistedMutationRevision);
    }
  }
  if (mutation.stateChanged) {
    record.stateRevision = persistedMutationRevision;
    record.stateRevisionKnown = true;
  }
  const mainKey = resolveRuntimeStoreKey(undefined);
  if (ownerKey !== mainKey || (!mutation.credentialsChanged && !mutation.profileSetChanged)) {
    return;
  }
  let deletedDerivedSnapshot = false;
  for (const key of runtimeAuthStoreSnapshots.keys()) {
    if (key !== mainKey) {
      runtimeAuthStoreSnapshots.delete(key);
      runtimeAuthStoreSnapshotRevisions.delete(key);
      deletedDerivedSnapshot = true;
    }
  }
  if (deletedDerivedSnapshot) {
    runtimeAuthStoreSnapshotsRevision += 1;
  }
}

/** Persisted mutation token for one store or profile credential. */
export function getRuntimeAuthProfileStoreCredentialMutationRevision(
  agentDir?: string,
  profileId?: string,
  options?: { includeMain?: boolean },
): number {
  return getRuntimeAuthProfileStoreCredentialMutationToken(agentDir, profileId, options).revision;
}

export type RuntimeAuthProfileStoreMutationToken = {
  revision: number;
  known: boolean;
};

function combineMutationTokens(
  tokens: RuntimeAuthProfileStoreMutationToken[],
): RuntimeAuthProfileStoreMutationToken {
  return {
    revision: Math.max(0, ...tokens.map((token) => token.revision)),
    known: tokens.every((token) => token.known),
  };
}

/** Bounded persisted credential lineage; unknown means its exact token was evicted. */
export function getRuntimeAuthProfileStoreCredentialMutationToken(
  agentDir?: string,
  profileId?: string,
  options?: { includeMain?: boolean },
): RuntimeAuthProfileStoreMutationToken {
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  if (!profileId) {
    const record = getPersistedMutationRecord(requestedKey);
    return record
      ? { revision: record.credentialRevision, known: record.credentialRevisionKnown }
      : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
  }
  const mainKey = resolveRuntimeStoreKey(undefined);
  const keys =
    requestedKey === mainKey || options?.includeMain !== true
      ? [requestedKey]
      : [requestedKey, mainKey];
  return combineMutationTokens(
    keys.map((key) => {
      const record = getPersistedMutationRecord(key);
      if (!record) {
        return { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
      }
      const revision = record.profileRevisions.get(profileId);
      return revision === undefined
        ? { revision: record.mutationFloor, known: record.mutationFloor === 0 }
        : { revision, known: true };
    }),
  );
}

/** Persisted token for profile-id additions and removals in one owner store. */
export function getRuntimeAuthProfileStoreProfileSetMutationToken(
  agentDir?: string,
): RuntimeAuthProfileStoreMutationToken {
  const ownerKey = resolveRuntimeStoreKey(agentDir);
  const record = getPersistedMutationRecord(ownerKey);
  return record
    ? { revision: record.profileSetRevision, known: record.profileSetRevisionKnown }
    : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
}

/** Persisted mutation token for non-secret selection state in one owner store. */
export function getRuntimeAuthProfileStoreStateMutationToken(
  agentDir?: string,
  options?: { includeMain?: boolean },
): RuntimeAuthProfileStoreMutationToken {
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  const mainKey = resolveRuntimeStoreKey(undefined);
  const keys =
    requestedKey === mainKey || options?.includeMain !== true
      ? [requestedKey]
      : [requestedKey, mainKey];
  return combineMutationTokens(
    keys.map((key) => {
      const record = getPersistedMutationRecord(key);
      return record
        ? { revision: record.stateRevision, known: record.stateRevisionKnown }
        : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
    }),
  );
}

export function getRuntimeAuthProfileStoreStateMutationRevision(agentDir?: string): number {
  return getRuntimeAuthProfileStoreStateMutationToken(agentDir).revision;
}

/** Stable token for credential ownership without coupling to usage bookkeeping. */
export function getRuntimeAuthProfileStoreCredentialsRevision(): number {
  return runtimeAuthStoreCredentialsRevision;
}

/** Process-local generation for one exact runtime snapshot rollback owner. */
export function getRuntimeAuthProfileStoreSnapshotRevision(agentDir?: string): number {
  return (
    runtimeAuthStoreSnapshotRevisions.get(resolveRuntimeStoreKey(agentDir)) ??
    runtimeAuthStoreSnapshotsRevision
  );
}

export const testing = {
  MAX_PERSISTED_MUTATION_OWNERS,
  MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER,
  getPersistedMutationRecordCounts(): { owners: number; profiles: number } {
    return {
      owners: persistedMutationRecords.size,
      profiles: Math.max(
        0,
        ...Array.from(persistedMutationRecords.values(), (record) => record.profileRevisions.size),
      ),
    };
  },
  resetPersistedMutationLineage(): void {
    persistedMutationRecords.clear();
    persistedMutationRevision = 0;
    evictedOwnerMutationFloor = 0;
  },
};
