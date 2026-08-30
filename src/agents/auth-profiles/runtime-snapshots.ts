import path from "node:path";
/**
 * Process-local auth profile snapshots used by prepared runtimes and tests.
 * Snapshots are cloned at boundaries so callers cannot mutate shared state.
 */
import { isDeepStrictEqual } from "node:util";
import { cloneAuthProfileStore } from "./clone.js";
import {
  captureAuthProfileOwnerScope,
  resolveSharedAuthStorePath,
  type AuthProfileOwnerScope,
} from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import {
  clearAllRuntimeAuthMaterializations,
  clearRuntimeAuthMaterializationsAtDatabasePath,
} from "./runtime-materializations.js";
import {
  captureRuntimeAuthProfileLegacyCandidates,
  cloneRuntimeAuthProfileLegacyCandidates,
  captureRuntimeAuthSharedOwner,
  cloneRuntimeAuthSharedOwner,
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeAuthSharedOwnerRebound,
  runtimeAuthCredentialState as credentialState,
  runtimeAuthOwnerState as ownerState,
  type RuntimeAuthSharedOwner,
  type RuntimeAuthProfileLegacyCandidates,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
  type AuthProfileStoreOwner,
  type PreparedAuthProfileStoreOwner,
} from "./sqlite.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

type OwnedRuntimeSnapshot = {
  store: RuntimeAuthProfileStore;
  owner: RuntimeAuthSharedOwner;
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates;
};
const runtimeAuthStoreSnapshots = new Map<string, OwnedRuntimeSnapshot>();

function runtimeStoreEntries(): Array<[string, RuntimeAuthProfileStore]> {
  return Array.from(runtimeAuthStoreSnapshots, ([key, entry]) => [key, entry.store]);
}
type RuntimeAuthProfileStoreMutationListener = (event: {
  agentDir?: string;
  affectsInheritedStores: boolean;
}) => void;
const runtimeAuthStoreMutationListeners = new Set<RuntimeAuthProfileStoreMutationListener>();
let runtimeAuthStoreCredentialsRevision = 0;
let runtimeAuthStoreSnapshotsRevision = 0;
// Per-store generations isolate rollback ownership; the global counter remains
// the deletion generation for keys no longer present in this map.
const runtimeAuthStoreSnapshotRevisions = new Map<string, number>();
let persistedMutationRevision = 0;
let evictedOwnerMutationFloor = 0;
const MAX_PERSISTED_MUTATION_OWNERS = 256;
const MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER = 256;

type RuntimeAuthProfileStoreSnapshotEntry = {
  databasePath?: string;
  agentDir?: string;
  store: RuntimeAuthProfileStore;
};

export {
  prepareRuntimeAuthProfileStoreSnapshots,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";

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

function advanceRuntimeAuthStoreSnapshotsRevision(): void {
  // Readers must close before consumers can observe the new snapshot generation.
  closeAuthProfileReadPool();
  runtimeAuthStoreSnapshotsRevision += 1;
}

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

function snapshotOwnershipState(entries: Iterable<[string, OwnedRuntimeSnapshot]>) {
  return Array.from(
    entries,
    ([key, entry]) =>
      [
        key,
        {
          state: ownerState(entry.store),
          owner: entry.owner,
          legacyCandidates: entry.legacyCandidates,
        },
      ] as const,
  ).toSorted(([left], [right]) => left.localeCompare(right));
}

function replaceChangesOwner(entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[]): boolean {
  const next = new Map(entries.map((entry) => [entry.databasePath, entry] as const));
  return !isDeepStrictEqual(
    snapshotOwnershipState(runtimeAuthStoreSnapshots),
    snapshotOwnershipState(next),
  );
}

function replaceChangesCredentials(entries: RuntimeAuthProfileStoreSnapshotEntry[]): boolean {
  const next = new Map(
    entries.map((entry) => [resolveRuntimeSnapshotEntryKey(entry), entry.store] as const),
  );
  return !isDeepStrictEqual(credentialState(runtimeStoreEntries()), credentialState(next));
}

function recordChangedSnapshotRevisions(
  entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[],
): boolean {
  const next = new Map(
    entries.map(
      (entry) =>
        [
          entry.databasePath,
          { store: entry.store, owner: entry.owner, legacyCandidates: entry.legacyCandidates },
        ] as const,
    ),
  );
  const keys = new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]);
  let changed = false;
  for (const key of keys) {
    if (isDeepStrictEqual(runtimeAuthStoreSnapshots.get(key), next.get(key))) {
      continue;
    }
    changed = true;
    advanceRuntimeAuthStoreSnapshotsRevision();
    if (next.has(key)) {
      runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
    } else {
      runtimeAuthStoreSnapshotRevisions.delete(key);
    }
  }
  return changed;
}

// Runtime snapshots are keyed by the canonical database path so default-agent
// and per-agent stores do not overwrite each other.
function resolveRuntimeStoreKey(agentDir?: string): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath();
}

function resolveRuntimeSnapshotEntryKey(entry: {
  databasePath?: string;
  agentDir?: string;
}): string {
  // Enumeration already owns the canonical key; never reconstruct it from a projected directory.
  return entry.databasePath ?? resolveRuntimeStoreKey(entry.agentDir);
}

function notifyRuntimeAuthStoreMutation(agentDir?: string): void {
  const event = {
    ...(agentDir ? { agentDir } : {}),
    affectsInheritedStores: agentDir === undefined,
  };
  for (const listener of runtimeAuthStoreMutationListeners) {
    listener(event);
  }
}

function authProfilesChanged(
  previous: RuntimeAuthProfileStore | undefined,
  next: RuntimeAuthProfileStore | undefined,
): boolean {
  return !isDeepStrictEqual(previous?.profiles ?? {}, next?.profiles ?? {});
}

/** Observes credential snapshot changes at their lifecycle publication edge. */
export function registerRuntimeAuthProfileStoreMutationListener(
  listener: RuntimeAuthProfileStoreMutationListener,
): () => void {
  runtimeAuthStoreMutationListeners.add(listener);
  return () => runtimeAuthStoreMutationListeners.delete(listener);
}

/** Reads a cloned runtime auth profile store snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshotCore(
  agentDir?: string,
): RuntimeAuthProfileStore | undefined {
  return getRuntimeAuthProfileStoreSnapshotAtDatabasePath(resolveRuntimeStoreKey(agentDir));
}

export function getRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  databasePath: string,
): RuntimeAuthProfileStore | undefined {
  const store = runtimeAuthStoreSnapshots.get(databasePath)?.store;
  return store ? cloneAuthProfileStore(store) : undefined;
}

export function getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  databasePath: string,
): OwnedRuntimeAuthProfileStoreSnapshotEntry | undefined {
  const entry = runtimeAuthStoreSnapshots.get(databasePath);
  return (
    entry && {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: cloneAuthProfileStore(entry.store),
      owner: cloneRuntimeAuthSharedOwner(entry.owner),
      legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
    }
  );
}

/**
 * Reads the effective prepared auth store without falling back to persisted storage.
 * Lifecycle consumers use this after auth publication so request paths never reopen SQLite.
 */
export function getPreparedRuntimeAuthProfileStoreSnapshotCore(
  agentDir?: string,
  inheritedAuthDir?: string,
): AuthProfileStore | undefined {
  const inherited = getRuntimeAuthProfileStoreSnapshotCore(inheritedAuthDir);
  const requested = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
  if (!agentDir || resolveRuntimeStoreKey(agentDir) === resolveRuntimeStoreKey(inheritedAuthDir)) {
    return requested ?? inherited;
  }
  if (inherited && requested) {
    return mergeAuthProfileStores(inherited, requested, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  return requested ?? inherited;
}

/** Lists cloned snapshots with their canonical database identity and producer ownership. */
export function listOwnedRuntimeAuthProfileStoreSnapshots(): OwnedRuntimeAuthProfileStoreSnapshotEntry[] {
  return Array.from(runtimeAuthStoreSnapshots, ([databasePath, entry]) => ({
    databasePath,
    agentDir: path.dirname(databasePath),
    store: cloneAuthProfileStore(entry.store),
    owner: cloneRuntimeAuthSharedOwner(entry.owner),
    legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
  }));
}

/** Select derived snapshots by their producer's shared owner, never directory shape. */
export function listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner: AuthProfileStoreOwner) {
  return listOwnedRuntimeAuthProfileStoreSnapshots().filter(
    (entry) =>
      entry.databasePath !== owner.sharedDatabasePath &&
      runtimeAuthProfileSnapshotSharesOwner(entry.owner, owner),
  );
}

/** Returns true when a runtime snapshot exists for an agent dir. */
export function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return runtimeAuthStoreSnapshots.has(resolveRuntimeStoreKey(agentDir));
}

/** Returns true when requested or main runtime snapshots contain profiles. */
export function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  const requestedStore = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
  if (requestedStore && Object.keys(requestedStore.profiles).length > 0) {
    return true;
  }
  if (!agentDir) {
    return false;
  }
  const mainStore = getRuntimeAuthProfileStoreSnapshotCore();
  return Boolean(mainStore && Object.keys(mainStore.profiles).length > 0);
}

/** Replaces all runtime auth profile snapshots with cloned entries. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
): void {
  const prepared = entries.map((entry): OwnedRuntimeAuthProfileStoreSnapshotEntry => {
    const databasePath = resolveRuntimeSnapshotEntryKey(entry);
    return {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: cloneAuthProfileStore(entry.store),
      owner: cloneRuntimeAuthSharedOwner(
        runtimeAuthStoreSnapshots.get(databasePath)?.owner ?? {
          kind: "unresolved",
          scope: captureAuthProfileOwnerScope(),
        },
      ),
      legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(
        runtimeAuthStoreSnapshots.get(databasePath)?.legacyCandidates ??
          captureRuntimeAuthProfileLegacyCandidates(
            entry.agentDir ?? (entry.databasePath ? path.dirname(databasePath) : undefined),
          ),
      ),
    };
  });
  replaceOwnedRuntimeAuthProfileStoreSnapshots(prepared);
}

export function replaceOwnedRuntimeAuthProfileStoreSnapshots(
  entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[],
): void {
  // Cold producer facts are enough to fence stale preparation; do not open SQLite
  // merely to avoid conservative invalidation for an irrelevant relocation.
  const reboundKeys = new Set(
    entries
      .filter((entry) => {
        const previous = runtimeAuthStoreSnapshots.get(entry.databasePath);
        return previous && runtimeAuthSharedOwnerRebound(previous.owner, entry.owner);
      })
      .map((entry) => entry.databasePath),
  );
  const credentialsChanged = replaceChangesCredentials(entries) || reboundKeys.size > 0;
  const ownerChanged = replaceChangesOwner(entries);
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const next = new Map(
    entries.map((entry) => [resolveRuntimeSnapshotEntryKey(entry), entry.store] as const),
  );
  for (const key of new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()])) {
    if (
      reboundKeys.has(key) ||
      authProfilesChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key))
    ) {
      clearRuntimeAuthMaterializationsAtDatabasePath(key);
    }
  }
  recordChangedSnapshotRevisions(entries);
  const nextOwned = entries.map((entry) => {
    const key = resolveRuntimeSnapshotEntryKey(entry);
    return [
      key,
      {
        store: cloneAuthProfileStore(entry.store),
        owner: cloneRuntimeAuthSharedOwner(entry.owner),
        legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
      },
    ] as const;
  });
  runtimeAuthStoreSnapshots.clear();
  for (const [key, entry] of nextOwned) {
    runtimeAuthStoreSnapshots.set(key, entry);
  }
  if (ownerChanged) {
    notifyRuntimeAuthStoreMutation();
  }
}

/** Clears all runtime auth profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  const snapshotsChanged = runtimeAuthStoreSnapshots.size > 0;
  const credentialsChanged = credentialState(runtimeStoreEntries()).length > 0;
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  if (snapshotsChanged) {
    advanceRuntimeAuthStoreSnapshotsRevision();
  } else {
    closeAuthProfileReadPool();
  }
  runtimeAuthStoreSnapshots.clear();
  clearAllRuntimeAuthMaterializations();
  runtimeAuthStoreSnapshotRevisions.clear();
  if (snapshotsChanged) {
    notifyRuntimeAuthStoreMutation();
  }
}

/** Clears one runtime auth-profile snapshot without disturbing other active agents. */
export function clearRuntimeAuthProfileStoreSnapshotCore(agentDir?: string): boolean {
  return clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    resolveRuntimeStoreKey(agentDir),
    agentDir,
  );
}

export function clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  key: string,
  agentDir?: string,
): boolean {
  const store = runtimeAuthStoreSnapshots.get(key)?.store;
  if (!store) {
    return false;
  }
  if (Object.keys(store.profiles).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  advanceRuntimeAuthStoreSnapshotsRevision();
  runtimeAuthStoreSnapshots.delete(key);
  clearRuntimeAuthMaterializationsAtDatabasePath(key);
  runtimeAuthStoreSnapshotRevisions.delete(key);
  notifyRuntimeAuthStoreMutation(agentDir);
  return true;
}

function setRuntimeAuthProfileStoreSnapshotAtKey(
  store: RuntimeAuthProfileStore,
  key: string,
  agentDir: string | undefined,
  owner: RuntimeAuthSharedOwner,
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates,
): void {
  const previous = runtimeAuthStoreSnapshots.get(key);
  const sharedOwnerChanged =
    !isDeepStrictEqual(previous?.owner, owner) ||
    !isDeepStrictEqual(previous?.legacyCandidates, legacyCandidates);
  const credentialsChanged = !isDeepStrictEqual(
    credentialState(
      runtimeAuthStoreSnapshots.has(key) ? [[key, runtimeAuthStoreSnapshots.get(key)!.store]] : [],
    ),
    credentialState([[key, store]]),
  );
  const sharedOwnerRebound = previous && runtimeAuthSharedOwnerRebound(previous.owner, owner);
  if (credentialsChanged || sharedOwnerRebound) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const previousStore = previous?.store;
  if (sharedOwnerRebound || authProfilesChanged(previousStore, store)) {
    clearRuntimeAuthMaterializationsAtDatabasePath(key);
  }
  const ownerChanged =
    sharedOwnerChanged || !isDeepStrictEqual(ownerState(previousStore), ownerState(store));
  const snapshotChanged = sharedOwnerChanged || !isDeepStrictEqual(previousStore, store);
  if (snapshotChanged) {
    advanceRuntimeAuthStoreSnapshotsRevision();
    runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
  }
  runtimeAuthStoreSnapshots.set(key, {
    store: cloneAuthProfileStore(store),
    owner: cloneRuntimeAuthSharedOwner(owner),
    legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(legacyCandidates),
  });
  if (ownerChanged) {
    notifyRuntimeAuthStoreMutation(agentDir);
  }
}

/** Stores a cloned runtime auth profile snapshot for an agent dir. */
export function setRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  setRuntimeAuthProfileStoreSnapshotAtKey(
    store,
    resolveRuntimeStoreKey(agentDir),
    agentDir,
    captureRuntimeAuthSharedOwner(),
    captureRuntimeAuthProfileLegacyCandidates(agentDir),
  );
}

/** Restore the captured runtime owner independently of the persistence transaction. */
export function restoreOwnedRuntimeAuthProfileStoreSnapshot(
  entry: OwnedRuntimeAuthProfileStoreSnapshotEntry,
  agentDir?: string,
): void {
  setRuntimeAuthProfileStoreSnapshotAtKey(
    entry.store,
    entry.databasePath,
    agentDir,
    entry.owner,
    entry.legacyCandidates,
  );
}

/** Materialization changes contents, not the existing producer's shared ownership. */
export function updateRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  const key = resolveRuntimeStoreKey(agentDir);
  const owner = runtimeAuthStoreSnapshots.get(key)?.owner ?? captureRuntimeAuthSharedOwner();
  setRuntimeAuthProfileStoreSnapshotAtKey(
    store,
    key,
    agentDir,
    owner,
    runtimeAuthStoreSnapshots.get(key)?.legacyCandidates ??
      captureRuntimeAuthProfileLegacyCandidates(agentDir),
  );
}

/** Stores a cloned snapshot under an already resolved canonical database owner. */
export function setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  store: RuntimeAuthProfileStore,
  databasePath: string,
  agentDir: string | undefined,
  owner: AuthProfileStoreOwner | PreparedAuthProfileStoreOwner,
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates,
): void {
  const existing = runtimeAuthStoreSnapshots.get(databasePath);
  const candidates =
    "env" in owner
      ? captureRuntimeAuthProfileLegacyCandidates(
          databasePath === owner.sharedDatabasePath ? undefined : agentDir,
          owner.env,
        )
      : (legacyCandidates ??
        (existing && runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)
          ? existing.legacyCandidates
          : undefined));
  setRuntimeAuthProfileStoreSnapshotAtKey(
    store,
    databasePath,
    agentDir,
    {
      kind: "resolved",
      sharedDatabasePath: owner.sharedDatabasePath,
      location: owner.location,
    },
    candidates,
  );
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
  owner?: AuthProfileStoreOwner,
): void {
  if (!mutation.credentialsChanged && !mutation.profileSetChanged && !mutation.stateChanged) {
    return;
  }
  persistedMutationRevision += 1;
  if (mutation.credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const ownerKey = owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    clearRuntimeAuthMaterializationsAtDatabasePath(ownerKey);
  }
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
  const mainKey = owner?.sharedDatabasePath ?? resolveRuntimeStoreKey(undefined);
  if (ownerKey !== mainKey || (!mutation.credentialsChanged && !mutation.profileSetChanged)) {
    return;
  }
  let deletedDerivedSnapshot = false;
  const sharedOwner = owner ?? captureRuntimeAuthSharedOwner();
  for (const [key, entry] of runtimeAuthStoreSnapshots) {
    if (key !== mainKey && runtimeAuthProfileSnapshotSharesOwner(entry.owner, sharedOwner)) {
      runtimeAuthStoreSnapshots.delete(key);
      runtimeAuthStoreSnapshotRevisions.delete(key);
      deletedDerivedSnapshot = true;
    }
  }
  if (deletedDerivedSnapshot) {
    advanceRuntimeAuthStoreSnapshotsRevision();
  }
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    notifyRuntimeAuthStoreMutation(agentDir);
  }
}

export type RuntimeAuthProfileStoreMutationToken = {
  revision: number;
  known: boolean;
};

export type RuntimeAuthProfileStoreMutationOwner =
  | { kind: "resolved"; databasePath: string; sharedDatabasePath: string }
  | { kind: "unresolved"; databasePath: string; scope: AuthProfileOwnerScope };

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
  options?: { includeMain?: boolean; owner?: RuntimeAuthProfileStoreMutationOwner },
): RuntimeAuthProfileStoreMutationToken {
  const requestedKey = options?.owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (!profileId) {
    const record = getPersistedMutationRecord(requestedKey);
    return record
      ? { revision: record.credentialRevision, known: record.credentialRevisionKnown }
      : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
  }
  if (options?.includeMain && options.owner?.kind === "unresolved") {
    return { revision: 0, known: false };
  }
  const mainKey = !options?.includeMain
    ? requestedKey
    : options.owner?.kind === "resolved"
      ? options.owner.sharedDatabasePath
      : resolveRuntimeStoreKey(undefined);
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
  databasePath?: string,
): RuntimeAuthProfileStoreMutationToken {
  const ownerKey = databasePath ?? resolveRuntimeStoreKey(agentDir);
  const record = getPersistedMutationRecord(ownerKey);
  return record
    ? { revision: record.profileSetRevision, known: record.profileSetRevisionKnown }
    : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
}

/** Persisted mutation token for non-secret selection state in one owner store. */
export function getRuntimeAuthProfileStoreStateMutationToken(
  agentDir?: string,
  options?: { includeMain?: boolean; owner?: RuntimeAuthProfileStoreMutationOwner },
): RuntimeAuthProfileStoreMutationToken {
  const requestedKey = options?.owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (options?.includeMain && options.owner?.kind === "unresolved") {
    return { revision: 0, known: false };
  }
  const mainKey = !options?.includeMain
    ? requestedKey
    : options.owner?.kind === "resolved"
      ? options.owner.sharedDatabasePath
      : resolveRuntimeStoreKey(undefined);
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

/** Stable token for credential ownership without coupling to usage bookkeeping. */
export function getRuntimeAuthProfileStoreCredentialsRevision(): number {
  return runtimeAuthStoreCredentialsRevision;
}

/** Process-local generation for one exact runtime snapshot rollback owner. */
export function getRuntimeAuthProfileStoreSnapshotRevision(agentDir?: string): number {
  return getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(resolveRuntimeStoreKey(agentDir));
}

/** Process-local generation for an already resolved canonical snapshot owner. */
export function getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(
  databasePath: string,
): number {
  return runtimeAuthStoreSnapshotRevisions.get(databasePath) ?? runtimeAuthStoreSnapshotsRevision;
}

const testing = {
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
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.runtimeAuthSnapshotsTestApi")] =
    testing;
}
